package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/XingLingQAQ/uptime/backends/go/internal/polaris"
)

func main() {
	values, err := loadEnvFile(".env")
	if err != nil {
		slog.Error("cannot load .env", "error", err)
		os.Exit(1)
	}
	env := func(key, fallback string) string {
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		if value, ok := values[key]; ok {
			return value
		}
		return fallback
	}
	c := polaris.DefaultConfig()
	flag.StringVar(&c.Addr, "addr", env("POLARIS_ADDR", c.Addr), "HTTP listen address")
	flag.StringVar(&c.DataDir, "data-dir", env("POLARIS_DATA_DIR", c.DataDir), "Persistent data directory")
	flag.StringVar(&c.FrontendDir, "frontend-dir", env("POLARIS_FRONTEND_DIR", c.FrontendDir), "Shared frontend build directory")
	flag.StringVar(&c.DatabaseURL, "database-url", env("POLARIS_DATABASE_URL", ""), "SQLite file or PostgreSQL URL")
	flag.Lookup("database-url").DefValue = ""
	c.AdminToken = env("POLARIS_ADMIN_TOKEN", "")
	c.SetupKey = env("POLARIS_SETUP_KEY", "")
	flag.BoolVar(&c.TrustProxy, "trust-proxy", false, "Trust reverse-proxy HTTPS headers")
	flag.IntVar(&c.Concurrency, "concurrency", c.Concurrency, "Maximum simultaneous probes")
	migration := flag.String("migration", "", "Offline SQLite-to-PostgreSQL migration: preview or execute")
	flag.Parse()
	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if !set["concurrency"] {
		c.Concurrency, err = strconv.Atoi(env("POLARIS_CONCURRENCY", "32"))
		if err != nil {
			slog.Error("POLARIS_CONCURRENCY must be an integer")
			os.Exit(1)
		}
	}
	if !set["trust-proxy"] {
		c.TrustProxy, err = strconv.ParseBool(env("POLARIS_TRUST_PROXY", "false"))
		if err != nil {
			slog.Error("POLARIS_TRUST_PROXY must be a boolean")
			os.Exit(1)
		}
	}
	if *migration != "" {
		if *migration != "preview" && *migration != "execute" {
			slog.Error("invalid migration mode")
			os.Exit(1)
		}
		if c.DatabaseURL == "" {
			c.DatabaseURL = filepath.Join(c.DataDir, "polaris.sqlite")
		}
		if strings.Contains(c.DatabaseURL, "://") || strings.HasPrefix(c.DatabaseURL, "file:") || strings.Contains(c.DatabaseURL, "?") {
			slog.Error("offline migration requires a SQLite file path")
			os.Exit(1)
		}
		if info, e := os.Stat(c.DatabaseURL); e != nil || !info.Mode().IsRegular() {
			slog.Error("offline migration source must be an existing SQLite file")
			os.Exit(1)
		}
		if env("POLARIS_MIGRATION_TARGET", "") == "" {
			slog.Error("POLARIS_MIGRATION_TARGET is required")
			os.Exit(1)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var app *polaris.App
	if *migration != "" {
		app, err = polaris.NewForOfflineMigration(ctx, c)
	} else {
		app, err = polaris.New(ctx, c)
	}
	if err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
	if *migration != "" {
		result, migrateErr := app.MigrateOffline(ctx, env("POLARIS_MIGRATION_TARGET", ""), *migration == "execute")
		closeErr := app.Close()
		if migrateErr != nil {
			slog.Error("migration failed", "error", migrateErr)
			os.Exit(1)
		}
		if closeErr != nil {
			slog.Error("database close failed", "error", closeErr)
			os.Exit(1)
		}
		_ = json.NewEncoder(os.Stdout).Encode(result)
		return
	}
	server := &http.Server{Addr: c.Addr, Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 << 10}
	listener, err := net.Listen("tcp", c.Addr)
	if err != nil {
		slog.Error("HTTP listen failed", "error", err)
		_ = app.Close()
		os.Exit(1)
	}
	// 确认监听成功后再生成并输出临时初始化密钥。
	// Generate and log the temporary setup key only after the listener succeeds.
	key, err := app.GenerateSetupKey()
	if err != nil {
		_ = listener.Close()
		_ = app.Close()
		slog.Error("setup key generation failed")
		os.Exit(1)
	}
	if key != "" {
		slog.Info("First-time setup key; use it only to initialize the administrator", "setup_key", key)
	}
	app.Start()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	slog.Info("Uptime Polaris Go listening", "address", listener.Addr().String())
	serveErr := server.Serve(listener)
	if serveErr != nil && serveErr != http.ErrServerClosed {
		slog.Error("HTTP server stopped", "error", serveErr)
	}
	if err = app.Close(); err != nil {
		slog.Error("database close failed", "error", err)
	}
	if serveErr != nil && serveErr != http.ErrServerClosed {
		os.Exit(1)
	}
}
