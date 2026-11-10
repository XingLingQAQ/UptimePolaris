package polaris

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Addr        string
	DataDir     string
	FrontendDir string
	DatabaseURL string
	AdminToken  string
	SetupKey    string
	Concurrency int
	TrustProxy  bool
}

func DefaultConfig() Config {
	return Config{Addr: "127.0.0.1:8080", DataDir: "./data", Concurrency: 32}
}

type App struct {
	config        Config
	store         *Store
	mux           *http.ServeMux
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	semaphore     chan struct{}
	icmpAvailable bool
	startedAt     time.Time
	storeLock     sync.RWMutex
	setupLock     sync.Mutex
	setupReady    chan struct{}
	readyOnce     sync.Once
}

type apiError struct {
	code   string
	status int
}

func (e *apiError) Error() string           { return e.code }
func failure(code string, status int) error { return &apiError{code, status} }

type handler func(http.ResponseWriter, *http.Request) error

func New(ctx context.Context, c Config) (*App, error) {
	return newApp(ctx, c, false)
}

func NewForOfflineMigration(ctx context.Context, c Config) (*App, error) {
	return newApp(ctx, c, true)
}

func newApp(ctx context.Context, c Config, offlineMigration bool) (*App, error) {
	if c.DataDir == "" {
		return nil, fmt.Errorf("data-dir is required")
	}
	if c.Concurrency < 1 || c.Concurrency > 1024 {
		return nil, fmt.Errorf("concurrency must be 1..1024")
	}
	if err := os.MkdirAll(c.DataDir, 0700); err != nil {
		return nil, err
	}
	if !offlineMigration {
		stored, err := readDatabaseConfig(c.DataDir)
		if err != nil {
			return nil, fmt.Errorf("database configuration unavailable")
		}
		if stored != "" {
			c.DatabaseURL = stored
		}
	}
	if c.DatabaseURL == "" {
		c.DatabaseURL = filepath.Join(c.DataDir, "polaris.sqlite")
	}
	s, err := OpenStore(ctx, c.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("database unavailable")
	}
	users, err := s.list(ctx, "user")
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("database unavailable")
	}
	ctx, cancel := context.WithCancel(ctx)
	a := &App{config: c, store: s, mux: http.NewServeMux(), ctx: ctx, cancel: cancel, semaphore: make(chan struct{}, c.Concurrency), icmpAvailable: icmpPermission(), startedAt: time.Now(), setupReady: make(chan struct{})}
	if len(users) > 0 {
		a.markSetupReady()
	}
	a.routes()
	return a, nil
}

func (a *App) Close() error { a.cancel(); a.wg.Wait(); return a.store.Close() }
func (a *App) Start() {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		select {
		case <-a.ctx.Done():
			return
		case <-a.setupReady:
		}
		a.storeLock.RLock()
		e := a.rollupHistory(a.ctx, false)
		a.storeLock.RUnlock()
		if e != nil && a.ctx.Err() == nil {
			slog.Error("history rollup failed", "error", e)
		}
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-ticker.C:
				a.storeLock.RLock()
				a.tick()
				a.storeLock.RUnlock()
			}
		}
	}()
}
func (a *App) route(pattern string, public bool, h handler) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		if !public && !a.authorized(r) {
			respond(w, 401, Object{"error": "unauthorized"})
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && !a.sameOrigin(r) {
			respond(w, 403, Object{"error": "invalid_origin"})
			return
		}
		if err := h(w, r); err != nil {
			var e *apiError
			if errors.As(err, &e) {
				respond(w, e.status, Object{"error": e.code})
				return
			}
			slog.Error("request failed", "method", r.Method, "route", pattern, "error", err)
			respond(w, 500, Object{"error": "internal_error"})
		}
	})
}

func (a *App) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/setup" {
			r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		}
		isSetup := r.Method == http.MethodPost && r.URL.Path == "/api/auth/setup"
		socketToken := strings.TrimPrefix(r.URL.Path, "/api/public/agent/")
		isAgentSocket := strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/public/agent/") && !strings.Contains(socketToken, "/") && socketToken != "capabilities" && socketToken != "manifest"
		if isSetup {
			if !a.setupLock.TryLock() {
				respond(w, 409, Object{"error": "setup_in_progress"})
				return
			}
			defer a.setupLock.Unlock()
			select {
			case <-a.setupReady:
				a.storeLock.RLock()
				defer a.storeLock.RUnlock()
			default:
				a.storeLock.Lock()
				defer a.storeLock.Unlock()
			}
		} else if !isAgentSocket {
			a.storeLock.RLock()
			defer a.storeLock.RUnlock()
		}
		ctx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(a.ctx, cancel)
		defer stop()
		defer cancel()
		r = r.WithContext(ctx)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
		if a.requireSetup(w, r) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			a.mux.ServeHTTP(w, r)
			return
		}

		if strings.HasPrefix(r.URL.Path, "/agent/") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/polaris-maintenance.js" {
			serveMaintenanceScript(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/theme/") {
			a.serveThemeAsset(w, r)
			return
		}
		if r.URL.Path == "/install.sh" || r.URL.Path == "/install.ps1" {
			if err := a.installer(w, r); err != nil {
				respond(w, 503, Object{"error": "agent_assets_unavailable"})
			}
			return
		}
		if a.serveThemePage(w, r) {
			return
		}
		var frontend fs.FS
		if a.config.FrontendDir != "" {
			frontend = os.DirFS(a.config.FrontendDir)
		} else {
			frontend = embeddedFrontend()
		}
		if frontend == nil {
			http.Error(w, "Frontend unavailable; build a release or set --frontend-dir", http.StatusServiceUnavailable)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if info, err := fs.Stat(frontend, name); err != nil || info.IsDir() {
			name = "index.html"
		}
		data, err := fs.ReadFile(frontend, name)
		if err != nil {
			if name == "index.html" {
				http.Error(w, "Web interface unavailable. Use the packaged program or configure --frontend-dir with a complete web build.", http.StatusServiceUnavailable)
			} else {
				http.NotFound(w, r)
			}
			return
		}
		if name == "index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	})
}

// Before setup, expose only form dependencies; tokens, public data, and reports cannot bypass the gate.
// 初始化前只提供表单依赖；令牌、公开数据和上报入口均不能绕过门禁。
func (a *App) requireSetup(w http.ResponseWriter, r *http.Request) bool {
	select {
	case <-a.setupReady:
		return false
	default:
	}
	path := r.URL.Path
	read := r.Method == http.MethodGet || r.Method == http.MethodHead
	if r.Method == http.MethodPost && path == "/api/auth/setup" {
		return false
	}
	if read && (path == "/api/auth/session" || path == "/api/capabilities" || path == "/api/public/icon" || path == "/setup" || path == "/setup/" || strings.HasPrefix(path, "/assets/") || path == "/favicon.ico") {
		return false
	}
	w.Header().Set("Cache-Control", "private, no-store")
	if read && path != "/api" && !strings.HasPrefix(path, "/api/") {
		http.Redirect(w, r, "/setup", http.StatusFound)
	} else {
		respond(w, http.StatusServiceUnavailable, Object{"error": "setup_required"})
	}
	return true
}

func (a *App) sameOrigin(r *http.Request) bool {
	if a.bearer(r) {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Site") != "cross-site"
	}
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, r.Host) && (u.Scheme == "http" || u.Scheme == "https")
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func body(r *http.Request) (Object, error) {
	var o Object
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&o); err != nil || o == nil {
		return nil, failure("invalid_request", 400)
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, failure("invalid_request", 400)
	}
	return o, nil
}
func token(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func uuid() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func (a *App) routes() {
	a.authRoutes()
	a.monitorRoutes()
	a.publicRoutes()
	a.settingsRoutes()
	a.taxonomyRoutes()
	a.agentRoutes()
	a.themeRoutes()
	a.notificationRoutes()
	a.route("GET /api/capabilities", true, func(w http.ResponseWriter, r *http.Request) error {
		native := []string{"http", "tcp", "udp", "dns", "tls", "websocket"}
		if a.icmpAvailable {
			native = append(native[:3], append([]string{"icmp"}, native[3:]...)...)
		}
		respond(w, 200, Object{"runtime": "go", "apiVersion": 1, "probeSource": "server", "monitoring": Object{"types": []string{"http", "tcp", "udp", "icmp", "dns", "tls", "websocket", "push", "agent"}, "nativeTypes": native, "minimumIntervalSec": 5, "minimumTimeoutMs": 100, "maximumTimeoutMs": 120000, "sslMode": "tls-handshake"}, "themes": Object{"storage": "filesystem", "installationAvailable": true}})
		return nil
	})
	a.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { respond(w, 404, Object{"error": "not_found"}) })
}
