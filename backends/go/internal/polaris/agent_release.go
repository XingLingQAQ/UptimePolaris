package polaris

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed agent-release-repository.json
var agentReleaseConfig embed.FS
var releaseRepository = func() string {
	raw, err := agentReleaseConfig.ReadFile("agent-release-repository.json")
	if err != nil {
		panic(err)
	}
	var v struct {
		Repository string `json:"repository"`
	}
	if json.Unmarshal(raw, &v) != nil || !regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`).MatchString(v.Repository) {
		panic("invalid Agent release repository")
	}
	return v.Repository
}()
var releaseCache struct {
	sync.Mutex
	value Object
	until time.Time
}
// 合并刷新请求；等待者拿到锁后重新检查五分钟缓存。
// Coalesce refreshes; waiters recheck the five-minute cache after acquiring the lock.
var releaseFetchLock sync.Mutex
var releaseRefreshRunning atomic.Bool

func refreshAgentRelease() {
	if !releaseRefreshRunning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer releaseRefreshRunning.Store(false)
		_, _ = latestAgentRelease()
	}()
}

// Release 的每次跳转都限制为允许的 HTTPS 主机。
// Restrict every release redirect to the allowed HTTPS hosts.
var releaseClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.User != nil || req.URL.Port() != "" || !(req.URL.Hostname() == "github.com" || req.URL.Hostname() == "api.github.com" || req.URL.Hostname() == "release-assets.githubusercontent.com") {
		return fmt.Errorf("invalid release redirect")
	}
	return nil
}}

func agentReleaseURL(tag, file string) string {
	return "https://github.com/" + releaseRepository + "/releases/download/" + tag + "/" + file
}
func releaseJSON(target string, limit int64, out any) error {
	req, err := http.NewRequest("GET", target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Uptime-Polaris")
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := releaseClient.Do(req)
	if err != nil {
		return failure("github_unavailable", 502)
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return failure("release_not_found", 501)
	}
	if res.StatusCode == 403 || res.StatusCode == 429 {
		return failure("github_rate_limited", 502)
	}
	if res.StatusCode != 200 {
		return failure("github_unavailable", 502)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(raw)) > limit || json.Unmarshal(raw, out) != nil {
		return failure("invalid_release", 502)
	}
	return nil
}
func latestAgentRelease() (Object, error) {
	releaseFetchLock.Lock()
	defer releaseFetchLock.Unlock()
	releaseCache.Lock()
	if time.Now().Before(releaseCache.until) {
		value := releaseCache.value
		releaseCache.Unlock()
		return value, nil
	}
	releaseCache.Unlock()
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      *bool  `json:"draft"`
		Prerelease *bool  `json:"prerelease"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		} `json:"assets"`
	}
	if err := releaseJSON("https://api.github.com/repos/"+releaseRepository+"/releases/latest", 1<<20, &release); err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`).MatchString(release.Tag) || release.Draft == nil || *release.Draft || release.Prerelease == nil || *release.Prerelease {
		return nil, failure("invalid_release", 502)
	}
	assets := map[string]struct {
		URL  string
		Size int64
	}{}
	for _, asset := range release.Assets {
		if _, exists := assets[asset.Name]; exists {
			return nil, failure("invalid_release", 502)
		}
		assets[asset.Name] = struct {
			URL  string
			Size int64
		}{asset.URL, asset.Size}
	}
	if assets["manifest.json"].URL != agentReleaseURL(release.Tag, "manifest.json") {
		return nil, failure("release_manifest_missing", 502)
	}
	manifest := Object{}
	if err := releaseJSON(agentReleaseURL(release.Tag, "manifest.json"), 65536, &manifest); err != nil {
		return nil, err
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if str(manifest, "tag") != release.Tag || str(manifest, "version") != version || str(manifest, "repository") != releaseRepository || len(array(manifest["platforms"])) == 0 {
		return nil, failure("invalid_release_manifest", 502)
	}
	// manifest 的文件名、大小和 URL 必须匹配同一 Release 的附件。
	// Manifest filenames, sizes, and URLs must match assets from the same release.
	seen := map[string]bool{}
	for _, item := range array(manifest["platforms"]) {
		e := object(item)
		key := str(e, "key")
		file := str(e, "file")
		ext := ""
		if key == "windows-x86_64" {
			ext = ".exe"
		}
		size, ok := e["size"].(float64)
		if !ok || size != math.Trunc(size) || !contains([]string{"linux-x86_64", "linux-aarch64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"}, key) || seen[key] || str(e, "version") != version || file != "polaris-agent-"+version+"-"+key+ext || size <= 0 || size > 64<<20 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(str(e, "sha256")) || assets[file].Size != int64(size) || assets[file].URL != agentReleaseURL(release.Tag, file) {
			return nil, failure("invalid_release_manifest", 502)
		}
		if parsed, err := url.Parse(assets[file].URL); err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" {
			return nil, failure("invalid_release_manifest", 502)
		}
		seen[key] = true
	}
	releaseCache.Lock()
	releaseCache.value = manifest
	releaseCache.until = time.Now().Add(5 * time.Minute)
	releaseCache.Unlock()
	return manifest, nil
}

func cachedAgentManifest() Object {
	releaseCache.Lock()
	defer releaseCache.Unlock()
	if time.Now().Before(releaseCache.until) {
		return releaseCache.value
	}
	return nil
}
