// Verify setup gates pages, business authentication, and Agent connections until setup succeeds.
// 验证初始化门禁先于页面、业务鉴权和 Agent 连接，并在初始化后解除。

package polaris

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupGate(t *testing.T) {
	s := newUninitializedTestServer(t)
	// Disable redirect following so the form's final 200 cannot hide a missing redirect.
	// 禁止自动跟随，否则最终表单的 200 会掩盖缺失的重定向。
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, path := range []string{"/", "/login", "/admin/settings?tab=database", "/monitor/2", "/server/2", "/status/other", "/unknown", "/theme/anything", "/agent/old", "/install.sh", "/setup/nested"} {
		for _, method := range []string{"GET", "HEAD"} {
			request, _ := http.NewRequest(method, s.server.URL+path, nil)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 302 || response.Header.Get("Location") != "/setup" || !strings.Contains(response.Header.Get("Cache-Control"), "no-store") {
				t.Fatalf("uninitialized %s %s: %d, %s", method, path, response.StatusCode, response.Header.Get("Location"))
			}
		}
	}
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"} {
		for _, path := range []string{"/api", "/api/monitors", "/api/public/status", "/api/public/push/fake", "/api/public/agent/fake", "/api/auth/login", "/api/auth/setup/", "/api/unknown"} {
			request, _ := http.NewRequest(method, s.server.URL+path, nil)
			request.Header.Set("Authorization", "Bearer "+s.config.AdminToken)
			if path == "/api/public/agent/fake" {
				request.Header.Set("Upgrade", "websocket")
				request.Header.Set("Connection", "Upgrade")
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 503 || method != "HEAD" && !strings.Contains(string(data), `"error":"setup_required"`) {
				t.Fatalf("uninitialized %s %s: %d %s", method, path, response.StatusCode, data)
			}
		}
	}
	for _, path := range []string{"/setup", "/setup/", "/api/auth/session", "/api/capabilities", "/api/public/icon"} {
		for _, method := range []string{"GET", "HEAD"} {
			request, _ := http.NewRequest(method, s.server.URL+path, nil)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("setup dependency %s %s: %d", method, path, response.StatusCode)
			}
		}
	}
	if err := os.Mkdir(filepath.Join(s.config.FrontendDir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.config.FrontendDir, "assets", "app.js"), []byte("window.fixture=true;"), 0600); err != nil {
		t.Fatal(err)
	}
	response, err := client.Get(s.server.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(data) != "window.fixture=true;" {
		t.Fatal("setup assets blocked", response.StatusCode, string(data))
	}
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, result)
	for _, path := range []string{"/", "/login", "/admin", "/unknown"} {
		response, err := client.Get(s.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("initialized page still blocked", path, response.StatusCode)
		}
	}
	response, err = client.Get(s.server.URL + "/api/monitors")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("initialized API must use ordinary authentication", response.StatusCode)
	}
}
