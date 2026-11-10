//go:build release

package polaris

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// 内置资源须在任意工作目录提供页面，不能依赖仓库的 public 目录。
// Embedded resources must serve pages from any working directory without the checkout's public directory.
func TestPackagedFrontend(t *testing.T) {
	t.Chdir(t.TempDir())
	config := DefaultConfig()
	config.DataDir = t.TempDir()
	app, err := New(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, route := range []string{"/", "/setup", "/login", "/admin", "/status/other", "/monitor/2"} {
		response, err := client.Get(server.URL + route)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if route != "/setup" {
			if response.StatusCode != 302 || response.Header.Get("Location") != "/setup" {
				t.Fatalf("packaged setup redirect %s: status=%d", route, response.StatusCode)
			}
			continue
		}
		if response.StatusCode != 200 || !strings.Contains(string(data), `id="root"`) {
			t.Fatalf("packaged %s: status=%d", route, response.StatusCode)
		}
		assets := regexp.MustCompile(`(?:src|href)="(/assets/[^"?]+)`).FindAllStringSubmatch(string(data), -1)
		if len(assets) == 0 {
			t.Fatal("packaged interface contains no built assets")
		}
		for _, asset := range assets {
			response, err = http.Get(server.URL + asset[1])
			if err != nil {
				t.Fatal(err)
			}
			data, _ = io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 200 || len(data) == 0 || strings.HasPrefix(response.Header.Get("Content-Type"), "text/html") {
				t.Fatalf("packaged asset %s: status=%d", asset[1], response.StatusCode)
			}
		}
	}
}
