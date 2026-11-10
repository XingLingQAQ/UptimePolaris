// 使用受控响应验证 Agent 下载版本契约。
// Check Agent release contracts using controlled responses.

package polaris

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (f releaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestAgentReleaseContract(t *testing.T) {
	original := releaseClient.Transport
	defer func() {
		releaseClient.Transport = original
		releaseCache.Lock()
		releaseCache.value = nil
		releaseCache.until = time.Time{}
		releaseCache.Unlock()
	}()
	tag, version := "v0.2.0", "0.2.0"
	file := "polaris-agent-0.2.0-linux-x86_64"
	entry := Object{"key": "linux-x86_64", "file": file, "version": version, "size": 7, "sha256": strings.Repeat("a", 64)}
	manifest := Object{"repository": releaseRepository, "tag": tag, "version": version, "platforms": []Object{entry}}
	mode := "limited"
	calls := 0
	releaseClient.Transport = releaseTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		status := 200
		var body []byte
		if mode == "limited" {
			status = 403
		} else if mode == "missing" {
			status = 404
		} else if r.URL.Host == "api.github.com" {
			body, _ = json.Marshal(Object{"tag_name": tag, "draft": false, "prerelease": false, "assets": []Object{{"name": "manifest.json", "browser_download_url": agentReleaseURL(tag, "manifest.json")}, {"name": file, "browser_download_url": agentReleaseURL(tag, file), "size": 7}}})
		} else {
			if mode == "bad" {
				manifest["repository"] = "other/repo"
			} else {
				manifest["repository"] = releaseRepository
			}
			body, _ = json.Marshal(manifest)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(string(body))), Header: make(http.Header), Request: r}, nil
	})
	if _, err := latestAgentRelease(); err == nil || err.Error() != "github_rate_limited" {
		t.Fatalf("rate limit: %v", err)
	}
	mode = "missing"
	if _, err := latestAgentRelease(); err == nil || err.Error() != "release_not_found" {
		t.Fatalf("missing release: %v", err)
	}
	mode = "bad"
	if _, err := latestAgentRelease(); err == nil || err.Error() != "invalid_release_manifest" {
		t.Fatalf("manifest: %v", err)
	}
	mode = "good"
	beforeLoad := calls
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := latestAgentRelease()
			if err != nil || str(got, "version") != version {
				t.Errorf("release: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls-beforeLoad != 2 {
		t.Fatalf("concurrent cache miss fetched %d times", calls-beforeLoad)
	}
	before := calls
	if _, err := latestAgentRelease(); err != nil || calls != before {
		t.Fatalf("cache: %v", err)
	}
}
