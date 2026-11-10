// 验证 Go 后端探测、公开展示、维护与头像接口。
// Check Go probes, public presentation, maintenance, and avatar APIs.

package polaris

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestICMPAdvertisementMatchesLoopbackProbe(t *testing.T) {
	s := newTestServer(t)
	code, result := s.request(t, "GET", "/api/capabilities", nil, false)
	expectStatus(t, code, 200, result)
	native := stringsOf(object(result["monitoring"])["nativeTypes"])
	if !s.app.icmpAvailable {
		if contains(native, "icmp") {
			t.Fatal("unavailable ICMP was advertised")
		}
		t.Log("ICMP is unavailable on this host; nativeTypes excludes it")
		return
	}
	id := s.createMonitor(t, "icmp", "127.0.0.1", nil)
	code, result = s.request(t, "POST", "/api/monitors/"+id+"/check", nil, true)
	expectStatus(t, code, 200, result)
	if integer(object(result["primary"]), "status") != 1 {
		t.Fatal("advertised ICMP could not probe loopback", result)
	}
	t.Logf("real ICMP loopback probe: status=%d latencyMs=%v", integer(result, "status"), result["latencyMs"])
}

func TestRetryLeaseAndSSLDailyCache(t *testing.T) {
	s := newTestServer(t)
	var failed atomic.Bool
	var entered atomic.Int32
	hold := make(chan struct{})
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/blocked" {
			entered.Add(1)
			<-hold
		}
		if failed.Load() {
			w.WriteHeader(503)
		} else {
			io.WriteString(w, "healthy")
		}
	}))
	defer fixture.Close()
	id := s.createMonitor(t, "http", fixture.URL, nil)
	failed.Store(true)
	for _, want := range []int{4, 4, 0} {
		code, result := s.request(t, "POST", "/api/monitors/"+id+"/check", nil, true)
		expectStatus(t, code, 200, result)
		if int(integer(result, "status")) != want {
			t.Fatal("retry policy mismatch", result)
		}
	}
	failed.Store(false)
	code, result := s.request(t, "POST", "/api/monitors/"+id+"/check", nil, true)
	expectStatus(t, code, 200, result)
	if integer(result, "status") != 1 || result["event"] != true {
		t.Fatal("recovery missing", result)
	}
	blockedID := s.createMonitor(t, "http", fixture.URL+"/blocked", nil)
	done := make(chan struct{})
	go func() { defer close(done); s.request(t, "POST", "/api/monitors/"+blockedID+"/check", nil, true) }()
	deadline := time.Now().Add(time.Second)
	for entered.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	code, result = s.request(t, "POST", "/api/monitors/"+blockedID+"/check", nil, true)
	expectStatus(t, code, 409, result)
	close(hold)
	<-done
	if entered.Load() != 1 {
		t.Fatal("duplicate probe lease executed", entered.Load())
	}
	certificateFixture := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	certificate := certificateFixture.TLS.Certificates[0]
	certificateFixture.Close()
	var handshakes atomic.Int32
	listener, e := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { handshakes.Add(1); return &certificate, nil }, MinVersion: tls.VersionTLS12})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				_, _ = conn.Read(make([]byte, 1))
			}()
		}
	}()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	code, created := s.request(t, "POST", "/api/monitors", Object{"name": "certificate addon", "type": "tcp", "target": "localhost:" + port, "check_ssl": 1, "timeout_ms": 1500, "interval_sec": 5}, true)
	expectStatus(t, code, 201, created)
	addonID := str(created, "id")
	for range 2 {
		code, result = s.request(t, "POST", "/api/monitors/"+addonID+"/check", nil, true)
		expectStatus(t, code, 200, result)
	}
	live, _ := s.app.store.get(context.Background(), "live", addonID)
	ssl := object(live["ssl"])
	if ssl["days"] == nil || str(ssl, "checkKey") == "" || handshakes.Load() != 1 {
		t.Fatal("TLS add-on did not use real daily handshake cache", ssl, handshakes.Load())
	}
}

func TestBrandEndpointAndNotificationCopies(t *testing.T) {
	s := newTestServer(t)
	for _, query := range []string{"", "?tight=1&size=32", "?container=1&tight=1&size=64"} {
		response, e := s.client.Get(s.server.URL + "/api/public/icon" + query)
		if e != nil {
			t.Fatal(e)
		}
		raw, _ := io.ReadAll(response.Body)
		response.Body.Close()
		svg := string(raw)
		if !strings.Contains(svg, `stroke="#006FEE"`) || !strings.Contains(svg, str(brandMark, "path")) {
			t.Fatal("brand geometry mismatch", svg)
		}
		if strings.Contains(query, "container=1") && !strings.Contains(svg, `fill="#ffffff"`) {
			t.Fatal("container not white", svg)
		}
	}
	root := filepath.Join("..", "..", "..", "..")
	for language, copy := range notificationCopy {
		raw, e := os.ReadFile(filepath.Join(root, "frontend", "src", "locales", "admin", language+".json"))
		if os.IsNotExist(e) {
			t.Skip("shared translation source is outside this checkout")
		}
		if e != nil {
			t.Fatal(e)
		}
		var source Object
		if e = json.Unmarshal(raw, &source); e != nil {
			t.Fatal(e)
		}
		if encode(object(object(source["notify"])["message"])) != encode(copy) {
			t.Fatal("notification translation snapshot is stale; run tools/sync-contracts.mjs", language)
		}
	}
}

func TestPresentationPreviewAndMaintenanceSemantics(t *testing.T) {
	s := newTestServer(t)
	code, result := s.request(t, "GET", "/api/public/config?preview=agent", nil, false)
	expectStatus(t, code, 401, result)
	code, result = s.request(t, "GET", "/api/public/config?preview=agent", nil, true)
	expectStatus(t, code, 200, result)
	if object(result["presentation"])["enabled"] != true {
		t.Fatal("authorized preview disabled", result)
	}
	_, state := s.request(t, "GET", "/api/admin/presentation", nil, true)
	config := object(state["config"])
	config["agentEnabled"] = true
	config["domains"] = []Object{{"hostname": "status.example", "page": "monitor"}, {"hostname": "servers.example", "page": "agent"}}
	code, result = s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/public/monitors", nil, false)
	expectStatus(t, code, 404, result)
	code, result = s.request(t, "PUT", "/api/admin/settings", Object{"maintenance.enabled": true, "maintenance.title": "Maintenance fixture", "maintenance.description": "Back shortly"}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "GET", "/api/public/maintenance", nil, false)
	expectStatus(t, code, 200, result)
	if result["active"] != true || str(result, "source") != "manual" || result["endsAt"] != nil {
		t.Fatal(result)
	}
	response, e := s.client.Get(s.server.URL + "/")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !strings.Contains(string(raw), "Maintenance fixture") {
		t.Fatal("maintenance shell missing")
	}
	response, e = s.client.Get(s.server.URL + "/admin")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if string(raw) != "shared frontend shell" {
		t.Fatal("maintenance replaced administrator UI")
	}
}

func TestMaintenanceDefersOutstandingAlerts(t *testing.T) {
	s := newTestServer(t)
	id := s.createMonitor(t, "push", "", nil)
	monitor, _ := s.app.store.get(context.Background(), "monitor", id)
	code, channel := s.request(t, "POST", "/api/notifications", Object{"name": "alerts", "type": "webhook", "config": Object{"url": "https://alerts.example/notify"}, "group_ids": []string{}}, true)
	expectStatus(t, code, 201, channel)
	_, e := s.app.persistCheck(context.Background(), monitor, CheckResult{Status: 1}, Object{}, true)
	if e != nil {
		t.Fatal(e)
	}
	code, result := s.request(t, "PUT", "/api/admin/settings", Object{"maintenance.enabled": true}, true)
	expectStatus(t, code, 200, result)
	result, e = s.app.persistCheck(context.Background(), monitor, CheckResult{Status: 0, Message: "expired"}, Object{}, true)
	if e != nil {
		t.Fatal(e)
	}
	if result["notified"] != false {
		t.Fatal("maintenance leaked an alert", result)
	}
	live, _ := s.app.store.get(context.Background(), "live", id)
	if live["alert_pending"] != true {
		t.Fatal("suppressed alert was forgotten", live)
	}
	code, result = s.request(t, "PUT", "/api/admin/settings", Object{"maintenance.enabled": false}, true)
	expectStatus(t, code, 200, result)
	result, e = s.app.persistCheck(context.Background(), monitor, CheckResult{Status: 0, Message: "still expired"}, Object{}, true)
	if e != nil {
		t.Fatal(e)
	}
	if result["notified"] != true {
		t.Fatal("outstanding outage was not announced after maintenance", result)
	}
	rows, e := s.app.store.list(context.Background(), "outbox")
	if e != nil || len(rows) != 1 {
		t.Fatal("deferred alert was duplicated", rows, e)
	}
}

func TestDNSDoHAndAuthoritativeRDAP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var bootstrapCalls atomic.Int32
	fixture := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/dns-query":
			io.WriteString(w, `{"Status":0,"Answer":[{"type":1,"data":"192.0.2.55"}]}`)
		case "/rdap/dns.json":
			bootstrapCalls.Add(1)
			io.WriteString(w, `{"services":[[["com"],["https://rdap.fixture/"]]]}`)
		case "/domain/example.com":
			_ = json.NewEncoder(w).Encode(Object{"events": []Object{{"eventAction": "expiration", "eventDate": time.Now().Add(365 * 24 * time.Hour).UTC().Format(time.RFC3339)}}})
		default:
			t.Errorf("unexpected RDAP request %s", r.URL)
			w.WriteHeader(404)
		}
	}))
	defer fixture.Close()
	old := http.DefaultTransport
	http.DefaultTransport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(fixture.URL, "https://"))
	}}
	defer func() { http.DefaultTransport = old }()
	rdapBootstrapMu.Lock()
	oldAt, oldMap := rdapBootstrapAt, rdapBootstrap
	rdapBootstrapAt = time.Time{}
	rdapBootstrap = nil
	rdapBootstrapMu.Unlock()
	defer func() {
		rdapBootstrapMu.Lock()
		rdapBootstrapAt, rdapBootstrap = oldAt, oldMap
		rdapBootstrapMu.Unlock()
	}()
	result, e := probeDNS(ctx, "example.com", Object{"recordType": "A", "expected": "192.0.2.55", "resolver": "https://dns.fixture/dns-query"})
	if e != nil || result.Status != 1 {
		t.Fatal(result, e)
	}
	for range 2 {
		result, e = probeDomain(ctx, "sub.example.com", 14)
		if e != nil || result.Status != 1 || result.DaysLeft == nil || *result.DaysLeft < 364 {
			t.Fatal(result, e)
		}
	}
	if bootstrapCalls.Load() != 1 {
		t.Fatal("IANA bootstrap was not cached", bootstrapCalls.Load())
	}
}

func TestAvatarPNGUploadReadAndDelete(t *testing.T) {
	s := newUninitializedTestServer(t)
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "avatar", "password": "avatar-password"}, false)
	expectStatus(t, code, 200, result)
	var buffer bytes.Buffer
	if e := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 16, 16))); e != nil {
		t.Fatal(e)
	}
	raw := buffer.Bytes()
	for _, fixture := range []struct {
		raw    []byte
		status int
	}{{append(append([]byte{}, raw...), []byte("trailing")...), 400}, {raw, 200}} {
		request, _ := http.NewRequest("POST", s.server.URL+"/api/auth/avatar", bytes.NewReader(fixture.raw))
		request.Header.Set("Content-Type", "image/png")
		response, e := s.client.Do(request)
		if e != nil {
			t.Fatal(e)
		}
		var result Object
		_ = json.NewDecoder(response.Body).Decode(&result)
		response.Body.Close()
		expectStatus(t, response.StatusCode, fixture.status, result)
	}
	code, result = s.request(t, "GET", "/api/auth/avatar", nil, false)
	expectStatus(t, code, 200, result)
	if result["uploaded"] != true {
		t.Fatal(result)
	}
	response, e := s.client.Get(s.server.URL + str(result, "url"))
	if e != nil {
		t.Fatal(e)
	}
	returned, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !bytes.Equal(raw, returned) {
		t.Fatal("avatar bytes changed")
	}
	code, result = s.request(t, "DELETE", "/api/auth/avatar", nil, false)
	expectStatus(t, code, 200, result)
	if result["uploaded"] != false {
		t.Fatal(result)
	}
}
