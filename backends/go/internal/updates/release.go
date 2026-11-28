package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var Version = "dev"
var Repository = "XingLingQAQ/UptimePolaris"
var ImageRepository = "ghcr.io/XingLingQAQ/uptimepolaris"

var stable = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var checksumLine = regexp.MustCompile(`^([0-9a-fA-F]{64}) [ *](\S+)$`)

func newer(a, b string) bool {
	aa, bb := stable.FindStringSubmatch(a), stable.FindStringSubmatch(b)
	if aa == nil || bb == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		if len(aa[i]) != len(bb[i]) {
			return len(aa[i]) > len(bb[i])
		}
		if aa[i] != bb[i] {
			return aa[i] > bb[i]
		}
	}
	return false
}

func supported(osName, arch string) bool {
	return (osName == "linux" || osName == "darwin" || osName == "windows") && (arch == "amd64" || arch == "arm64")
}
func assetName(version, osName, arch string) string {
	name := "polaris-" + strings.TrimPrefix(version, "v") + "-" + osName + "-" + arch
	if osName == "windows" {
		name += ".exe"
	}
	return name
}

type Release struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
	} `json:"assets"`
}
type Releases struct {
	Client     *http.Client
	Repository string
	API        string
	Downloads  string
}

func officialClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || req.URL.Scheme != "https" || req.URL.User != nil || req.URL.Port() != "" {
			return errors.New("release_redirect_invalid")
		}
		switch req.URL.Hostname() {
		case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
			return nil
		}
		return errors.New("release_redirect_invalid")
	}}
}
func OfficialReleases() *Releases {
	return &Releases{Client: officialClient(), Repository: Repository, API: "https://api.github.com", Downloads: "https://github.com"}
}
func (r *Releases) get(ctx context.Context, address string, limit int64) ([]byte, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", address, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Uptime-Polaris-Updater")
	res, e := r.Client.Do(req)
	if e != nil {
		return nil, errors.New("update_network_failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("update_release_unavailable")
	}
	raw, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil || int64(len(raw)) > limit {
		return nil, errors.New("update_response_invalid")
	}
	return raw, nil
}
func (r *Releases) Latest(ctx context.Context) (*Release, error) {
	var latest *Release
	for page := 1; page <= 10; page++ {
		raw, e := r.get(ctx, r.API+"/repos/"+r.Repository+"/releases?per_page=100&page="+strconv.Itoa(page), 4<<20)
		if e != nil {
			return nil, e
		}
		var entries []Release
		if json.Unmarshal(raw, &entries) != nil {
			return nil, errors.New("update_response_invalid")
		}
		for _, entry := range entries {
			if !entry.Draft && !entry.Prerelease && stable.MatchString(entry.Tag) && (latest == nil || newer(entry.Tag, latest.Tag)) {
				copy := entry
				latest = &copy
			}
		}
		if len(entries) < 100 {
			return latest, nil
		}
	}
	return nil, errors.New("update_response_invalid")
}
func (r *Releases) Download(ctx context.Context, release Release, osName, arch, destination string) error {
	name := assetName(release.Tag, osName, arch)
	found, sumFound := false, false
	for _, a := range release.Assets {
		found = found || a.Name == name
		sumFound = sumFound || a.Name == "SHA256SUMS.txt"
	}
	if !found || !sumFound {
		return errors.New("update_asset_missing")
	}
	base := r.Downloads + "/" + r.Repository + "/releases/download/" + url.PathEscape(release.Tag) + "/"
	raw, e := r.get(ctx, base+"SHA256SUMS.txt", 256<<10)
	if e != nil {
		return e
	}
	expected := ""
	for _, line := range strings.Split(string(raw), "\n") {
		m := checksumLine.FindStringSubmatch(strings.TrimSpace(line))
		if m != nil && m[2] == name {
			if expected != "" {
				return errors.New("update_checksum_invalid")
			}
			expected = strings.ToLower(m[1])
		}
	}
	if expected == "" {
		return errors.New("update_checksum_invalid")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", base+url.PathEscape(name), nil)
	if e != nil {
		return e
	}
	res, e := r.Client.Do(req)
	if e != nil {
		return errors.New("update_network_failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || res.ContentLength > 512<<20 {
		return errors.New("update_download_failed")
	}
	f, e := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if e != nil {
		return errors.New("update_storage_failed")
	}
	good := false
	defer func() {
		f.Close()
		if !good {
			os.Remove(destination)
		}
	}()
	digest := sha256.New()
	n, e := io.Copy(io.MultiWriter(f, digest), io.LimitReader(res.Body, (512<<20)+1))
	if e != nil || n == 0 || n > 512<<20 {
		return errors.New("update_download_failed")
	}
	if hex.EncodeToString(digest.Sum(nil)) != expected {
		return errors.New("update_checksum_mismatch")
	}
	if e = f.Sync(); e != nil {
		return fmt.Errorf("update_storage_failed")
	}
	good = true
	return f.Close()
}

func (r *Releases) Compatible(ctx context.Context, release Release) error {
	raw, e := r.get(ctx, r.Downloads+"/"+r.Repository+"/releases/download/"+url.PathEscape(release.Tag)+"/polaris-update.json", 4096)
	if e != nil {
		return errors.New("update_manual_required")
	}
	var info Info
	if json.Unmarshal(raw, &info) != nil || info.Protocol != Protocol || info.Storage != Storage || strings.TrimPrefix(info.Version, "v") != strings.TrimPrefix(release.Tag, "v") {
		return errors.New("update_manual_required")
	}
	return nil
}
