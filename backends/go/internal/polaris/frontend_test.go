// 验证网页资源、SPA 路由和资源缺失时的故障响应。
// Check web assets, SPA routes, and responses when the web interface is missing.

package polaris

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFrontendRoutes(t *testing.T) {
	config := DefaultConfig()
	config.DataDir = t.TempDir()
	config.FrontendDir = t.TempDir()
	config.SetupKey = "frontend-setup-fixture"
	const shell = "<!doctype html><title>Polaris fixture</title>"
	if err := os.WriteFile(filepath.Join(config.FrontendDir, "index.html"), []byte(shell), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(config.FrontendDir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config.FrontendDir, "assets", "app.js"), []byte("window.fixture = true;"), 0600); err != nil {
		t.Fatal(err)
	}
	app, err := New(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	for _, route := range []string{"/setup", "/setup/"} {
		response, err := http.Get(server.URL + route)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || string(data) != shell || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/html") {
			t.Fatalf("%s: status=%d body=%s error=%v", route, response.StatusCode, data, err)
		}
	}
	response, err := http.Get(server.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(data) != "window.fixture = true;" {
		t.Fatal("static asset unavailable", response.StatusCode, string(data))
	}
	response, err = http.Post(server.URL+"/api/auth/setup", "application/json", strings.NewReader(`{"credential":"frontend-setup-fixture","username":"owner","password":"fixture-owner-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("setup failed", response.StatusCode)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, route := range []string{"/", "/login", "/admin", "/monitor/2", "/server/2", "/unknown"} {
		response, err := client.Get(server.URL + route)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || string(data) != shell {
			t.Fatal("initialized SPA unavailable", route, response.StatusCode)
		}
	}
	if err = os.Remove(filepath.Join(config.FrontendDir, "index.html")); err != nil {
		t.Fatal(err)
	}
	response, err = http.Get(server.URL + "/setup")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatal("missing interface must report a deployment failure", response.StatusCode)
	}
}
