// 验证 Go 账号、持久化、探测、主题、Agent 和通知。
// Check Go accounts, persistence, probes, themes, Agents, and notifications.

package polaris

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/miekg/dns"
)

type testServer struct {
	app    *App
	server *httptest.Server
	client *http.Client
	config Config
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	s := newUninitializedTestServer(t)
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "fixture-owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, result)
	s.client.Jar, _ = cookiejar.New(nil)
	return s
}

// 初始化测试单独使用空库；普通功能测试通过真实初始化入口建立账户。
// Setup tests keep an empty database; feature fixtures create an account through the real setup endpoint.
func newUninitializedTestServer(t *testing.T) *testServer {
	t.Helper()
	config := DefaultConfig()
	config.DataDir = t.TempDir()
	config.AdminToken = "integration-admin-token"
	config.SetupKey = "integration-setup-key"
	config.FrontendDir = t.TempDir()
	config.Concurrency = 4
	if e := os.WriteFile(filepath.Join(config.FrontendDir, "index.html"), []byte("shared frontend shell"), 0600); e != nil {
		t.Fatal(e)
	}
	return openTestServer(t, config)
}
func openTestServer(t *testing.T, config Config) *testServer {
	t.Helper()
	app, e := New(context.Background(), config)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(app.Handler())
	jar, _ := cookiejar.New(nil)
	s := &testServer{app: app, server: server, client: &http.Client{Jar: jar}, config: config}
	t.Cleanup(func() { server.Close(); _ = app.Close() })
	return s
}
func (s *testServer) request(t *testing.T, method, path string, value any, admin bool) (int, Object) {
	t.Helper()
	var raw []byte
	if value != nil {
		raw = []byte(encode(value))
	}
	request, e := http.NewRequest(method, s.server.URL+path, bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	request.Header.Set("Content-Type", "application/json")
	if admin {
		request.Header.Set("Authorization", "Bearer "+s.config.AdminToken)
	}
	response, e := s.client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	data, e := io.ReadAll(response.Body)
	if e != nil {
		t.Fatal(e)
	}
	var out Object
	if json.Unmarshal(data, &out) != nil {
		t.Fatalf("%s %s: non-JSON %d %s", method, path, response.StatusCode, data)
	}
	return response.StatusCode, out
}
func expectStatus(t *testing.T, got, want int, result Object) {
	t.Helper()
	if got != want {
		t.Fatalf("status %d, want %d: %s", got, want, encode(result))
	}
}
func (s *testServer) createMonitor(t *testing.T, kind, target string, opts Object) string {
	t.Helper()
	input := Object{"name": kind + " fixture", "type": kind, "target": target, "interval_sec": 5, "timeout_ms": 1500, "options_json": opts}
	if opts == nil {
		input["options_json"] = Object{}
	}
	status, result := s.request(t, "POST", "/api/monitors", input, true)
	expectStatus(t, status, 201, result)
	return str(result, "id")
}

func TestAccountSessionAndPersistence(t *testing.T) {
	s := newUninitializedTestServer(t)
	code, result := s.request(t, "GET", "/api/auth/session", nil, false)
	expectStatus(t, code, 200, result)
	if result["needsSetup"] != true || str(result, "setupCredential") != "SETUP_KEY" {
		t.Fatal(result)
	}
	code, result = s.request(t, "POST", "/api/auth/setup", Object{"credential": "wrong", "username": "admin", "password": "long-enough-password"}, false)
	expectStatus(t, code, 401, result)
	code, result = s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "Admin", "password": "long-enough-password"}, false)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/monitors", nil, false)
	expectStatus(t, code, 200, result)
	request, _ := http.NewRequest("POST", s.server.URL+"/api/groups", strings.NewReader(`{"name":"cross-site"}`))
	request.Header.Set("Origin", "https://attacker.example")
	response, e := s.client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cross-origin session write accepted")
	}
	code, result = s.request(t, "POST", "/api/auth/logout", nil, false)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/monitors", nil, false)
	expectStatus(t, code, 401, result)
	code, result = s.request(t, "POST", "/api/auth/login", Object{"username": "admin", "password": "long-enough-password"}, false)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "POST", "/api/auth/account", Object{"current": "long-enough-password", "username": "owner", "next": "new-long-password"}, false)
	expectStatus(t, code, 200, result)
	id := s.createMonitor(t, "http", "http://127.0.0.1:1/health", nil)
	s.server.Close()
	if e = s.app.Close(); e != nil {
		t.Fatal(e)
	}
	second := openTestServer(t, s.config)
	code, result = second.request(t, "POST", "/api/auth/login", Object{"username": "owner", "password": "new-long-password"}, false)
	expectStatus(t, code, 200, result)
	code, result = second.request(t, "GET", "/api/monitors", nil, false)
	expectStatus(t, code, 200, result)
	if len(array(result["monitors"])) != 1 || str(object(array(result["monitors"])[0]), "id") != id {
		t.Fatal("SQLite restart lost monitor", result)
	}
}

func tcpFixture(t *testing.T) string {
	t.Helper()
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				buffer := make([]byte, 128)
				n, _ := conn.Read(buffer)
				_, _ = conn.Write(append([]byte("echo:"), buffer[:n]...))
			}()
		}
	}()
	return listener.Addr().String()
}
func udpFixture(t *testing.T) string {
	t.Helper()
	conn, e := net.ListenPacket("udp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { conn.Close() })
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, address, e := conn.ReadFrom(buffer)
			if e != nil {
				return
			}
			_, _ = conn.WriteTo(buffer[:n], address)
		}
	}()
	return conn.LocalAddr().String()
}
func dnsFixture(t *testing.T) string {
	t.Helper()
	conn, e := net.ListenPacket("udp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := &dns.Server{PacketConn: conn, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, request *dns.Msg) {
		reply := new(dns.Msg)
		reply.SetReply(request)
		reply.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: request.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 30}, A: net.ParseIP("192.0.2.42")}}
		_ = w.WriteMsg(reply)
	})}
	go server.ActivateAndServe()
	t.Cleanup(func() { server.Shutdown() })
	return conn.LocalAddr().String()
}

func TestNativeProbesAndPublicRedaction(t *testing.T) {
	s := newTestServer(t)
	httpFixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Fixture", "yes")
		_, _ = io.WriteString(w, `{"status":"healthy"}`)
	}))
	defer httpFixture.Close()
	wsFixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, e := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer conn.Close()
		kind, data, e := conn.ReadMessage()
		if e == nil {
			_ = conn.WriteMessage(kind, data)
		}
	}))
	defer wsFixture.Close()
	tlsFixture := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer tlsFixture.Close()
	fixtures := []struct {
		kind, target string
		options      Object
		status       int
	}{{"http", httpFixture.URL + "/health?token=private-query", Object{"headers": Object{"X-Test": "private-header"}, "jsonPath": "status", "jsonExpected": "healthy", "headerName": "X-Fixture", "headerExpected": "yes"}, 1}, {"tcp", tcpFixture(t), Object{"send": "PING", "expect": "echo:PING"}, 1}, {"udp", udpFixture(t), Object{"send": "70696e67", "expect": "70696e67", "encoding": "hex"}, 1}, {"dns", "fixture.example", Object{"dns": Object{"recordType": "A", "expected": "192.0.2.42", "resolver": dnsFixture(t)}}, 1}, {"tls", strings.TrimPrefix(tlsFixture.URL, "https://"), Object{"serverName": "fixture.example"}, 2}, {"websocket", "ws" + strings.TrimPrefix(wsFixture.URL, "http"), Object{"send": "hello", "expect": "hello"}, 1}}
	for _, fixture := range fixtures {
		t.Run(fixture.kind, func(t *testing.T) {
			id := s.createMonitor(t, fixture.kind, fixture.target, fixture.options)
			code, result := s.request(t, "POST", "/api/monitors/"+id+"/check", nil, true)
			expectStatus(t, code, 200, result)
			if integer(result, "status") != int64(fixture.status) {
				t.Fatal(result)
			}
			live, e := s.app.store.get(context.Background(), "live", id)
			if e != nil || live == nil || live["v"] == nil {
				t.Fatal("probe not persisted", live, e)
			}
			if fixture.kind == "tls" && object(result["primary"])["daysLeft"] == nil {
				t.Fatal("missing real certificate expiry", result)
			}
		})
	}
	code, result := s.request(t, "GET", "/api/capabilities", nil, false)
	expectStatus(t, code, 200, result)
	monitoring := object(result["monitoring"])
	if integer(monitoring, "minimumIntervalSec") != 5 || str(result, "runtime") != "go" {
		t.Fatal(result)
	}
	code, result = s.request(t, "GET", "/api/public/status", nil, false)
	expectStatus(t, code, 200, result)
	raw := encode(result)
	for _, secret := range []string{"private-query", "private-header", "options_json", "push_token", "certificate verification failed"} {
		if strings.Contains(raw, secret) {
			t.Fatal("public response leaked", secret, raw)
		}
	}
	code, result = s.request(t, "POST", "/api/monitors", Object{"name": "invalid source", "type": "http", "target": httpFixture.URL, "options_json": Object{"check_source": Object{"type": "worker"}}}, true)
	expectStatus(t, code, 400, result)
	code, result = s.request(t, "POST", "/api/monitors", Object{"name": "too fast", "type": "http", "target": httpFixture.URL, "interval_sec": 4}, true)
	expectStatus(t, code, 400, result)
}

func TestVisibilityTaxonomyPushAndHistory(t *testing.T) {
	s := newTestServer(t)
	code, group := s.request(t, "POST", "/api/groups", Object{"name": "Services", "weight": 2}, true)
	expectStatus(t, code, 201, group)
	code, tag := s.request(t, "POST", "/api/tags", Object{"name": "Critical", "color": "#FF0000"}, true)
	expectStatus(t, code, 201, tag)
	code, monitor := s.request(t, "POST", "/api/monitors", Object{"name": "Private Push", "type": "push", "group_id": group["id"], "tag_ids": []string{str(tag, "id")}, "interval_sec": 5}, true)
	expectStatus(t, code, 201, monitor)
	id := str(monitor, "id")
	code, result := s.request(t, "POST", "/api/monitors/visibility", Object{"ids": []string{id, "missing"}, "is_public": false}, true)
	expectStatus(t, code, 404, result)
	stored, _ := s.app.store.get(context.Background(), "monitor", id)
	if !boolean(stored["is_public"]) {
		t.Fatal("non-atomic visibility")
	}
	code, result = s.request(t, "GET", "/api/public/push/"+str(monitor, "push_token"), nil, false)
	expectStatus(t, code, 405, result)
	code, result = s.request(t, "POST", "/api/public/push/"+str(monitor, "push_token")+"?status=1&ping=123", nil, false)
	expectStatus(t, code, 200, result)
	if e := s.app.passiveCheck(context.Background(), stored); e != nil {
		t.Fatal(e)
	}
	live, _ := s.app.store.get(context.Background(), "live", id)
	if live["v"] != nil || integer(live, "st") != 1 {
		t.Fatal("Push fabricated latency", live)
	}
	code, result = s.request(t, "POST", "/api/monitors/visibility", Object{"ids": []string{id}, "is_public": false}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/public/monitors/1", nil, false)
	expectStatus(t, code, 404, result)
	code, result = s.request(t, "DELETE", "/api/groups/"+str(group, "id"), nil, true)
	expectStatus(t, code, 200, result)
	stored, _ = s.app.store.get(context.Background(), "monitor", id)
	if stored["group_id"] != nil {
		t.Fatal("group reference retained")
	}
	old := time.Now().Add(-10 * 24 * time.Hour).Unix()
	_, e := s.app.store.db.Exec(s.app.store.query(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES(?,?,1,NULL,0,'','{}')`), id, old)
	if e != nil {
		t.Fatal(e)
	}
	code, result = s.request(t, "PUT", "/api/admin/settings", Object{"retention.detailDays": 1}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "POST", "/api/cron/sync", nil, true)
	expectStatus(t, code, 200, result)
	points, e := s.app.readings(context.Background(), id, old-1, 100)
	if e != nil {
		t.Fatal(e)
	}
	for _, point := range points {
		if point.ts == old {
			t.Fatal("raw detail not pruned")
		}
	}
	days := s.app.history(context.Background(), id, points)
	if len(days) != 1 || integer(days[0], "t") != 1 {
		t.Fatal("daily availability lost during detail pruning", days)
	}
}

func packageZip(t *testing.T, manifest Object, extra map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	all := map[string]string{"polaris-theme.json": encode(manifest), "index.html": `<!doctype html><html><head><link rel="stylesheet" href="/assets/theme.css"></head><body>Fixture theme<script src="/assets/theme.js"></script></body></html>`, "assets/theme.css": "body{color:#123456}", "assets/theme.js": "window.fixture=true"}
	for k, v := range extra {
		all[k] = v
	}
	for name, content := range all {
		file, e := writer.Create(name)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = io.WriteString(file, content)
	}
	if e := writer.Close(); e != nil {
		t.Fatal(e)
	}
	return buffer.Bytes()
}
func themeManifest() Object {
	return Object{"schema": 2, "id": "fixture", "short": "fixture", "name": "Fixture", "version": "1.0.0", "themes": []Object{{"id": "status", "name": "Status", "target": "monitor", "entry": "index.html", "capabilities": []string{"public.config", "public.monitors"}, "options": []Object{{"key": "accent", "label": "Accent", "type": "color", "default": "#123456"}}}}}
}
func (s *testServer) upload(t *testing.T, raw []byte) (int, Object) {
	t.Helper()
	req, _ := http.NewRequest("POST", s.server.URL+"/api/themes/install", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/zip")
	req.Header.Set("Authorization", "Bearer "+s.config.AdminToken)
	response, e := s.client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	var result Object
	if e = json.NewDecoder(response.Body).Decode(&result); e != nil {
		t.Fatal(e)
	}
	return response.StatusCode, result
}

// 直接安装公开示例 ZIP，避免重新构造夹具漏掉打包或编码错误。
// Install the shipped example ZIP directly so rebuilt fixtures cannot hide packaging or encoding errors.
func TestExampleThemePackage(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "examples", "themes", "polaris-simple")
	raw, err := os.ReadFile(filepath.Join(path, "polaris-simple.zip"))
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(filepath.Join(path, "polaris-theme.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, files, err := readThemeZip(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(source, files["polaris-theme.json"]) || str(manifest, "id") != "polaris-simple" || len(array(manifest["themes"])) != 2 {
		t.Fatal("shipped manifest differs from the source", manifest)
	}
	s := newTestServer(t)
	code, installed := s.upload(t, raw)
	expectStatus(t, code, 200, installed)
	for _, theme := range []string{"monitor", "agent"} {
		code, preview := s.request(t, "GET", "/api/themes/polaris-simple/preview?version="+str(installed, "versionKey")+"&theme="+theme, nil, true)
		expectStatus(t, code, 200, preview)
	}
}

func TestThemeFilesystemLifecycle(t *testing.T) {
	s := newTestServer(t)
	code, installed := s.upload(t, packageZip(t, themeManifest(), nil))
	expectStatus(t, code, 200, installed)
	prefix := str(installed, "prefix")
	if !prefixPattern.MatchString(prefix) {
		t.Fatal(installed)
	}
	if _, e := os.Stat(filepath.Join(s.config.DataDir, filepath.FromSlash(prefix), "index.html")); e != nil {
		t.Fatal("assets not persisted", e)
	}
	code, preview := s.request(t, "GET", "/api/themes/fixture/preview?version="+str(installed, "versionKey")+"&theme=status", nil, true)
	expectStatus(t, code, 200, preview)
	if str(object(preview["values"]), "accent") != "#123456" {
		t.Fatal(preview)
	}
	_, state := s.request(t, "GET", "/api/admin/presentation", nil, true)
	config := object(state["config"])
	page := object(object(config["pages"])["monitor"])
	page["theme"] = Object{"short": "fixture", "version": installed["versionKey"], "theme": "status"}
	page["themeOptions"] = Object{"accent": "#abcdef"}
	code, result := s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, result)
	state = result
	config = object(state["config"])
	page = object(object(config["pages"])["monitor"])
	page["headCode"] = `<style>body{color:red}</style><script>window.customHead=true</script>`
	page["contentHtml"] = "<b>Public content</b>"
	code, result = s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/public/config", nil, false)
	expectStatus(t, code, 200, result)
	if str(object(result["theme_settings"]), "accent") != "#abcdef" || str(result, "theme_content_html") != "<b>Public content</b>" {
		t.Fatal("theme options missing", result)
	}
	response, e := s.client.Get(s.server.URL + "/")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !bytes.Contains(raw, []byte("/theme/"+prefix+"/")) || !bytes.Contains(raw, []byte("polaris-theme-sdk.js")) || !bytes.Contains(raw, []byte(`<style>body{color:red}</style><script>window.customHead=true</script>`)) {
		t.Fatal("theme shell not served", string(raw))
	}
	response, e = s.client.Get(s.server.URL + "/theme/" + prefix + "/assets/theme.css")
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	code, result = s.upload(t, packageZip(t, themeManifest(), map[string]string{"../escape": "evil"}))
	expectStatus(t, code, 400, result)
	code, result = s.request(t, "DELETE", "/api/themes/fixture", nil, true)
	expectStatus(t, code, 200, result)
	if _, e = os.Stat(filepath.Join(s.config.DataDir, "themes", "fixture")); !os.IsNotExist(e) {
		t.Fatal("theme files survived deletion", e)
	}
	code, result = s.request(t, "GET", "/api/public/theme", nil, false)
	expectStatus(t, code, 200, result)
	if result["id"] != nil {
		t.Fatal("deleted theme still active", result)
	}
}

func reportParams(observed int64) Object {
	return Object{"cpu": Object{"usage": 12}, "ram": Object{"total": 1000, "used": 400}, "swap": Object{"total": 0, "used": 0}, "load": Object{"load1": 0.5, "load5": 0.3, "load15": 0.2}, "disk": Object{"total": 1000, "used": 200}, "network": Object{"up": 123, "down": 456, "totalUp": 1000, "totalDown": 2000}, "connections": Object{"tcp": 3, "udp": 2}, "uptime": 100, "process": 20, "observed_at": observed, "message": "private machine message"}
}
func TestAgentRPCQueuesConfigurationAndRedaction(t *testing.T) {
	s := newTestServer(t)
	code, created := s.request(t, "POST", "/api/admin/agents", Object{"name": "Machine", "probe_enabled": true}, true)
	expectStatus(t, code, 201, created)
	id, secret := str(created, "id"), str(created, "token")
	now := time.Now().Unix()
	frames := []Object{{"jsonrpc": "2.0", "id": 1, "method": "basicReport", "params": Object{"name": "hostname", "os": "linux", "arch": "x86_64", "cpu_model": "CPU", "cpu_cores": 2, "publicIp": "198.51.100.88", "capabilities": []string{"probe_http", "commands"}, "report_interval_secs": 60}}, {"jsonrpc": "2.0", "id": 2, "method": "report", "params": reportParams(now)}}
	code, result := s.request(t, "POST", "/api/public/agent/push/"+secret, frames, false)
	expectStatus(t, code, 200, result)
	if integer(result, "accepted") != 2 {
		t.Fatal(result)
	}
	code, result = s.request(t, "POST", "/api/public/agent/push/"+secret, frames[1], false)
	expectStatus(t, code, 200, result)
	if integer(result, "ignored") != 1 {
		t.Fatal("duplicate report not ignored", result)
	}
	wsURL := "ws" + strings.TrimPrefix(s.server.URL, "http") + "/api/public/agent/" + secret
	conn, _, e := websocket.DefaultDialer.Dial(wsURL, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = conn.WriteJSON(Object{"jsonrpc": "2.0", "id": 3, "method": "event", "params": Object{"name": "fixture"}}); e != nil {
		t.Fatal(e)
	}
	var ack Object
	if e = conn.ReadJSON(&ack); e != nil {
		t.Fatal(e)
	}
	conn.Close()
	if object(ack["result"])["ack"] != true {
		t.Fatal(ack)
	}
	monitorID := s.createMonitor(t, "http", "https://example.com", Object{"check_source": Object{"type": "agent", "agent_id": id}})
	monitor, _ := s.app.store.get(context.Background(), "monitor", monitorID)
	if e = s.app.scheduleAgentProbe(context.Background(), monitor); e != nil {
		t.Fatal(e)
	}
	code, result = s.request(t, "GET", "/api/public/agent/jobs/"+secret, nil, false)
	expectStatus(t, code, 200, result)
	jobs := array(result["jobs"])
	if len(jobs) != 1 {
		t.Fatal(result)
	}
	job := object(jobs[0])
	input := Object{"run_id": job["run_id"], "lease_token": "stale", "status": 1, "latency_ms": 12, "status_code": 200, "observed_at": now, "message": "healthy", "addons": Object{}}
	code, result = s.request(t, "POST", "/api/public/agent/results/"+secret, input, false)
	expectStatus(t, code, 409, result)
	input["lease_token"] = job["lease_token"]
	code, result = s.request(t, "POST", "/api/public/agent/results/"+secret, input, false)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "POST", "/api/public/agent/results/"+secret, input, false)
	expectStatus(t, code, 200, result)
	if result["duplicate"] != true {
		t.Fatal(result)
	}
	_, _ = s.app.store.db.Exec(`UPDATE polaris_leases SET next_due=0 WHERE id='monitor:` + monitorID + `'`)
	if e = s.app.scheduleAgentProbe(context.Background(), monitor); e != nil {
		t.Fatal(e)
	}
	live, _ := s.app.store.get(context.Background(), "live", monitorID)
	if integer(live, "st") != 1 || integer(live, "source_observed_at") != now {
		t.Fatal("agent result not consumed", live)
	}
	code, result = s.request(t, "POST", "/api/admin/agents/"+id+"/commands", Object{"action": "restart"}, true)
	expectStatus(t, code, 403, result)
	code, result = s.request(t, "PUT", "/api/admin/settings", Object{"security.allowAgentCommands": true}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "POST", "/api/admin/agents/"+id+"/commands", Object{"action": "restart"}, true)
	expectStatus(t, code, 200, result)
	commandID := str(result, "id")
	code, result = s.request(t, "GET", "/api/public/agent/jobs/"+secret, nil, false)
	expectStatus(t, code, 200, result)
	commands := array(result["commands"])
	if len(commands) != 1 {
		t.Fatal(result)
	}
	command := object(commands[0])
	code, result = s.request(t, "POST", "/api/public/agent/commands/"+secret+"/result", Object{"id": commandID, "lease_token": command["lease_token"], "ok": true, "message": "restarting"}, false)
	expectStatus(t, code, 200, result)
	config := Object{"sample_interval_secs": 5, "report_interval_secs": 60, "include_nics": []string{}, "exclude_nics": []string{"lo"}, "include_mounts": []string{}, "exclude_mounts": []string{}, "auto_update": false}
	installation := Object{"service_tier": "systemd", "config_path": "/etc/polaris-agent/config.json", "executable_path": "/usr/local/bin/polaris-agent", "auto_update_supported": true}
	code, result = s.request(t, "POST", "/api/public/agent/config/"+secret, Object{"config": config, "installation": installation, "revision": nil}, false)
	expectStatus(t, code, 200, result)
	config["sample_interval_secs"] = 10
	code, result = s.request(t, "PUT", "/api/admin/agents/"+id+"/config", Object{"config": config, "expected_revision": nil}, true)
	expectStatus(t, code, 200, result)
	revision := result["revision"]
	code, result = s.request(t, "POST", "/api/public/agent/config/"+secret, Object{"config": config, "installation": installation, "revision": revision}, false)
	expectStatus(t, code, 200, result)
	if result["runtime_config"] != nil {
		t.Fatal("config apply not acknowledged", result)
	}
	code, result = s.request(t, "POST", "/api/monitors", Object{"name": "Machine monitor", "type": "agent", "agent_id": id}, true)
	expectStatus(t, code, 201, result)
	code, result = s.request(t, "GET", "/api/public/agent/detail/2", nil, false)
	expectStatus(t, code, 200, result)
	raw := encode(result)
	if strings.Contains(raw, "198.51.100.88") || strings.Contains(raw, "private machine message") || strings.Contains(raw, secret) || result["buckets"] == nil || result["availability"] == nil {
		t.Fatal("public machine projection invalid", result)
	}
}

func TestAllNotificationProviders(t *testing.T) {
	s := newTestServer(t)
	var mu sync.Mutex
	received := []Object{}
	fixture := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		received = append(received, Object{"host": r.Host, "path": r.URL.Path, "body": string(raw), "contentType": r.Header.Get("Content-Type")})
		mu.Unlock()
		switch {
		case strings.Contains(r.Host, "telegram"):
			io.WriteString(w, `{"ok":true}`)
		case strings.Contains(r.Host, "feishu"), strings.Contains(r.Host, "ft07"):
			io.WriteString(w, `{"code":0}`)
		case strings.Contains(r.Host, "discord"):
			w.WriteHeader(204)
		default:
			io.WriteString(w, "ok")
		}
	}))
	defer fixture.Close()
	oldTransport := http.DefaultTransport
	http.DefaultTransport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if strings.HasSuffix(address, ":443") {
			address = strings.TrimPrefix(fixture.URL, "https://")
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}}
	defer func() { http.DefaultTransport = oldTransport }()
	for _, kind := range notificationTypes {
		config := Object{"language": "zh-CN", "url": "https://webhook.example/notify", "webhook_url": "https://" + kind + ".example/notify", "bot_token": "123456:fixture-not-real", "chat_id": "1", "sendkey": "sctp123tfixture", "key": "stored-config", "urls": "tgram://fixture"}
		code, channel := s.request(t, "POST", "/api/notifications", Object{"name": kind, "type": kind, "config": config, "group_ids": []string{}}, true)
		expectStatus(t, code, 201, channel)
		for _, language := range []string{"zh-CN", "en-US"} {
			if language != "zh-CN" {
				config["language"] = language
				code, result := s.request(t, "PUT", "/api/notifications/"+str(channel, "id"), Object{"config": config}, true)
				expectStatus(t, code, 200, result)
			}
			code, result := s.request(t, "POST", "/api/notifications/"+str(channel, "id")+"/test", nil, true)
			expectStatus(t, code, 200, result)
			if result["ok"] != true {
				t.Fatal(kind, language, result)
			}
			mu.Lock()
			request := received[len(received)-1]
			mu.Unlock()
			var text string
			if kind == "serverchan" {
				form, err := url.ParseQuery(str(request, "body"))
				if err != nil {
					t.Fatal(err)
				}
				text = form.Get("desp")
			} else {
				var payload Object
				if err := json.Unmarshal([]byte(str(request, "body")), &payload); err != nil {
					t.Fatal(err)
				}
				switch kind {
				case "feishu":
					text = str(object(payload["content"]), "text")
				case "discord":
					text = str(payload, "content")
				case "apprise":
					text = str(payload, "body")
				default:
					text = str(payload, "text")
				}
				if kind == "telegram" {
					text = html.UnescapeString(text)
				}
			}
			var expected, excluded []string
			if language == "zh-CN" {
				expected = []string{"测试通知", "故障", "状态：正常 -> 故障", "目标：https://example.com", "这是一条来自 Uptime Polaris 的测试通知。"}
				excluded = []string{"Test notification", "State: UP -> DOWN"}
			} else {
				expected = []string{"Test notification", "State: UP -> DOWN", "Target: https://example.com", "This is a test notification from Uptime Polaris."}
				excluded = []string{"测试通知", "状态：正常 -> 故障"}
			}
			for _, value := range expected {
				if !strings.Contains(text, value) {
					t.Fatalf("%s %s missing %q in %q", kind, language, value, text)
				}
			}
			for _, value := range excluded {
				if strings.Contains(text, value) {
					t.Fatalf("%s %s retained previous language %q", kind, language, text)
				}
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2*len(notificationTypes) {
		t.Fatal("providers not sent", len(received))
	}
}
