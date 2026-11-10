package polaris

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var themeIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var versionPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
var prefixPattern = regexp.MustCompile(`^themes/[a-z0-9-]+/[0-9A-Za-z.+-]+/[a-f0-9]{64}/[0-9a-f-]{36}$`)

func knownFields(o Object, keys []string) bool {
	for k := range o {
		if !contains(keys, k) {
			return false
		}
	}
	return true
}
func safeThemePath(name string) bool {
	if name == "" || len(name) > 240 || strings.ContainsAny(name, "\\\x00:") || strings.HasPrefix(name, "/") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasPrefix(part, ".") || strings.TrimRight(part, " .") != part {
			return false
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if contains([]string{"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"}, base) {
			return false
		}
	}
	return true
}
func validThemeOption(option Object, value any) bool {
	switch str(option, "type") {
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "number":
		return validNumber(value) && (option["min"] == nil || number(value) >= number(option["min"])) && (option["max"] == nil || number(value) <= number(option["max"]))
	default:
		s, ok := value.(string)
		max := 2048
		if str(option, "type") == "textarea" {
			max = 16000
		}
		if !ok || len(s) > max {
			return false
		}
		if str(option, "type") == "color" {
			return colorPattern.MatchString(s)
		}
		if str(option, "type") == "select" {
			return contains(stringsOf(option["choices"]), s)
		}
		return true
	}
}

func validateManifest(m Object) error {
	fail := func(code string) error { return failure(code, 400) }
	if m == nil {
		return fail("manifest_not_object")
	}
	if !knownFields(m, []string{"schema", "id", "short", "name", "version", "description", "author", "themes"}) {
		return fail("manifest_field_unknown")
	}
	if integer(m, "schema") != 2 {
		return fail("manifest_schema_unsupported")
	}
	if !themeIDPattern.MatchString(str(m, "id")) {
		return fail("manifest_id_invalid")
	}
	if !themeIDPattern.MatchString(str(m, "short")) || contains([]string{"admin", "api", "assets", "login", "setup"}, str(m, "short")) {
		return fail("manifest_short_invalid")
	}
	if strings.TrimSpace(str(m, "name")) == "" || len(str(m, "name")) > 120 {
		return fail("manifest_name_invalid")
	}
	if !versionPattern.MatchString(str(m, "version")) || len(str(m, "version")) > 95 {
		return fail("manifest_version_invalid")
	}
	if len(str(m, "description")) > 500 || len(str(m, "author")) > 120 {
		return fail("manifest_metadata_invalid")
	}
	definitions, ok := m["themes"].([]any)
	if !ok || len(definitions) < 1 || len(definitions) > 20 {
		return fail("manifest_themes_invalid")
	}
	seen := map[string]bool{}
	for _, v := range definitions {
		d := object(v)
		if d == nil || !knownFields(d, []string{"id", "name", "target", "entry", "capabilities", "options"}) {
			return fail("manifest_theme_invalid")
		}
		id := str(d, "id")
		if !themeIDPattern.MatchString(id) || seen[id] {
			return fail("manifest_theme_id_invalid")
		}
		seen[id] = true
		if strings.TrimSpace(str(d, "name")) == "" || len(str(d, "name")) > 120 || !contains([]string{"monitor", "agent"}, str(d, "target")) {
			return fail("manifest_theme_invalid")
		}
		if !safeThemePath(str(d, "entry")) || !regexp.MustCompile(`(?i)\.html?$`).MatchString(str(d, "entry")) {
			return fail("manifest_entry_invalid")
		}
		capabilities, ok := d["capabilities"].([]any)
		if !ok {
			return fail("manifest_capability_invalid")
		}
		allowed := []string{"public.config", "public.status", "public.monitors", "public.monitor-detail", "public.agent-detail"}
		if str(d, "target") == "agent" {
			allowed = []string{"public.config", "public.servers", "public.server-detail"}
		}
		for _, cap := range capabilities {
			if !contains(allowed, fmt.Sprint(cap)) {
				return fail("manifest_capability_invalid")
			}
		}
		options, ok := d["options"].([]any)
		if !ok || len(options) > 100 {
			return fail("manifest_options_invalid")
		}
		keys := map[string]bool{}
		for _, v := range options {
			o := object(v)
			key := str(o, "key")
			if o == nil || !knownFields(o, []string{"key", "label", "type", "default", "choices", "description", "min", "max", "step"}) || !regexp.MustCompile(`^[a-z][a-zA-Z0-9_]{0,63}$`).MatchString(key) || keys[key] || strings.TrimSpace(str(o, "label")) == "" || len(str(o, "label")) > 120 || len(str(o, "description")) > 500 {
				return fail("manifest_option_invalid")
			}
			keys[key] = true
			kind := str(o, "type")
			if !contains([]string{"string", "textarea", "color", "number", "boolean", "select", "monitor", "agent"}, kind) {
				return fail("manifest_option_type_invalid")
			}
			if kind == "monitor" && str(d, "target") != "monitor" || kind == "agent" && str(d, "target") != "agent" {
				return fail("manifest_option_target_invalid")
			}
			if kind == "select" && (len(array(o["choices"])) < 1 || len(array(o["choices"])) > 100 || len(stringsOf(o["choices"])) != len(array(o["choices"]))) {
				return fail("manifest_option_choices_invalid")
			}
			for _, k := range []string{"min", "max", "step"} {
				if v, exists := o[k]; exists && (kind != "number" || !validNumber(v)) {
					return fail("manifest_option_range_invalid")
				}
			}
			if o["min"] != nil && o["max"] != nil && number(o["min"]) > number(o["max"]) || o["step"] != nil && number(o["step"]) <= 0 {
				return fail("manifest_option_range_invalid")
			}
			if value, exists := o["default"]; exists && !validThemeOption(o, value) {
				return fail("manifest_option_default_invalid")
			}
		}
	}
	return nil
}

func readThemeZip(raw []byte) (Object, map[string][]byte, error) {
	if len(raw) > 32<<20 {
		return nil, nil, failure("package_too_large", 413)
	}
	archive, e := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if e != nil {
		return nil, nil, failure("invalid_zip", 400)
	}
	if len(archive.File) > 500 {
		return nil, nil, failure("too_many_files", 400)
	}
	files := map[string][]byte{}
	seen := map[string]bool{}
	total := uint64(0)
	for _, file := range archive.File {
		if file.FileInfo().IsDir() {
			continue
		}
		name := file.Name
		if !safeThemePath(name) || file.Mode()&os.ModeSymlink != 0 || !file.Mode().IsRegular() {
			return nil, nil, failure("unsafe_path", 400)
		}
		folded := strings.ToLower(name)
		if seen[folded] {
			return nil, nil, failure("duplicate_path", 400)
		}
		seen[folded] = true
		total += file.UncompressedSize64
		if total > 32<<20 {
			return nil, nil, failure("package_too_large", 413)
		}
		reader, e := file.Open()
		if e != nil {
			return nil, nil, failure("invalid_zip", 400)
		}
		content, e := io.ReadAll(io.LimitReader(reader, int64(file.UncompressedSize64)+1))
		_ = reader.Close()
		if e != nil || uint64(len(content)) != file.UncompressedSize64 {
			return nil, nil, failure("invalid_zip", 400)
		}
		files[name] = content
	}
	rawManifest, ok := files["polaris-theme.json"]
	if !ok {
		return nil, nil, failure("manifest_missing", 400)
	}
	var manifest Object
	if json.Unmarshal(rawManifest, &manifest) != nil {
		return nil, nil, failure("manifest_invalid_json", 400)
	}
	if e = validateManifest(manifest); e != nil {
		return nil, nil, e
	}
	for _, v := range array(manifest["themes"]) {
		if _, ok := files[str(object(v), "entry")]; !ok {
			return nil, nil, failure("entry_missing", 400)
		}
	}
	return manifest, files, nil
}

func (a *App) downloadTheme(ctx context.Context, source string) ([]byte, error) {
	u, e := url.Parse(source)
	if e != nil || u.Host == "" || !contains([]string{"http", "https"}, u.Scheme) {
		return nil, failure("bad_url", 400)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", source, nil)
	client := &http.Client{CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || !contains([]string{"http", "https"}, r.URL.Scheme) {
			return fmt.Errorf("invalid redirect")
		}
		return nil
	}}
	response, e := client.Do(req)
	if e != nil {
		return nil, failure("download_failed", 502)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, failure("download_failed", 502)
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 32<<20+1))
	if e != nil {
		return nil, failure("download_failed", 502)
	}
	if len(raw) > 32<<20 {
		return nil, failure("package_too_large", 413)
	}
	return raw, nil
}

func themeAssetReferences(files map[string][]byte, prefix string) error {
	pattern := regexp.MustCompile(`(["'(])(/(?:assets|static|fonts|img|images)/[^"'\s)<>]+)`)
	for name, content := range files {
		extension := strings.ToLower(path.Ext(name))
		if !contains([]string{".html", ".htm", ".css", ".js", ".mjs", ".cjs"}, extension) {
			continue
		}
		missing := false
		rewritten := pattern.ReplaceAllStringFunc(string(content), func(value string) string {
			quote := value[:1]
			reference := value[1:]
			u, e := url.Parse(reference)
			if e != nil {
				missing = true
				return value
			}
			decoded, e := url.PathUnescape(strings.TrimPrefix(u.Path, "/"))
			if e != nil {
				missing = true
				return value
			}
			directory := path.Dir(name)
			resolved := ""
			for {
				candidate := path.Join(directory, decoded)
				if _, ok := files[candidate]; ok {
					resolved = candidate
					break
				}
				if directory == "." || directory == "/" {
					break
				}
				directory = path.Dir(directory)
			}
			if resolved == "" {
				missing = true
				return value
			}
			suffix := ""
			if u.RawQuery != "" {
				suffix += "?" + u.RawQuery
			}
			if u.Fragment != "" {
				suffix += "#" + u.Fragment
			}
			return quote + "/theme/" + prefix + "/" + resolved + suffix
		})
		if missing {
			return failure("root_asset_missing", 400)
		}
		files[name] = []byte(rewritten)
	}
	return nil
}

// 先校验 ZIP 和资源引用，再暂存文件；数据库登记失败时清理本次新目录。
// Validate ZIPs and asset references before staging; remove newly installed files if registry writes fail.
func (a *App) installTheme(ctx context.Context, raw []byte, source string) (Object, error) {
	manifest, files, e := readThemeZip(raw)
	if e != nil {
		return nil, e
	}
	id, short, version := str(manifest, "id"), str(manifest, "short"), str(manifest, "version")
	owner := token(16)
	claimed, e := a.store.claim(ctx, "theme:"+id, owner, time.Now().Unix(), 120, true)
	if e != nil {
		return nil, e
	}
	if !claimed {
		return nil, failure("theme_busy", 409)
	}
	defer a.store.release(context.Background(), "theme:"+id, owner, 0)
	// Package identity is part of the version contract. / 包摘要属于主题版本契约。
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	versionKey := version + "-" + digest
	prefix := "themes/" + id + "/" + version + "/" + digest + "/" + uuid()
	existing, e := a.store.get(ctx, "theme_version", id+":"+versionKey)
	if e != nil {
		return nil, e
	}
	if existing != nil {
		prefix = str(existing, "prefix")
	}
	if e = themeAssetReferences(files, prefix); e != nil {
		return nil, e
	}
	directory := filepath.Join(a.config.DataDir, filepath.FromSlash(prefix))
	if existing == nil {
		if e = os.MkdirAll(filepath.Dir(directory), 0700); e != nil {
			return nil, e
		}
		stage, e := os.MkdirTemp(filepath.Dir(directory), ".install-")
		if e != nil {
			return nil, e
		}
		defer os.RemoveAll(stage)
		for name, content := range files {
			file := filepath.Join(stage, filepath.FromSlash(name))
			if e = os.MkdirAll(filepath.Dir(file), 0700); e != nil {
				return nil, e
			}
			if e = os.WriteFile(file, content, 0600); e != nil {
				return nil, e
			}
		}
		if e = os.Rename(stage, directory); e != nil {
			return nil, e
		}
	}
	total := 0
	for _, content := range files {
		total += len(content)
	}
	e = a.store.mutate(ctx, func(t *transaction) error {
		all, e := t.list("theme")
		if e != nil {
			return e
		}
		for _, theme := range all {
			if str(theme, "id") == id && str(theme, "short") != short || str(theme, "short") == short && str(theme, "id") != id {
				return failure("theme_id_short_conflict", 409)
			}
		}
		theme, e := t.get("theme", short)
		if e != nil {
			return e
		}
		if boolean(theme["deleting"]) {
			return failure("theme_busy", 409)
		}
		if source == "" && theme != nil {
			source = str(theme, "sourceUrl")
		}
		theme = Object{"id": id, "short": short, "name": manifest["name"], "version": version, "description": manifest["description"], "author": manifest["author"], "sourceUrl": nil, "digest": digest, "deleting": false}
		if source != "" {
			theme["sourceUrl"] = source
		}
		if e = t.put("theme", short, theme); e != nil {
			return e
		}
		return t.put("theme_version", id+":"+versionKey, Object{"id": id, "versionKey": versionKey, "version": version, "digest": digest, "prefix": prefix, "manifest": manifest})
	})
	if e != nil {
		if existing == nil {
			_ = os.RemoveAll(directory)
		}
		return nil, e
	}
	return Object{"ok": true, "id": id, "short": short, "version": version, "versionKey": versionKey, "digest": digest, "prefix": prefix, "files": len(files), "bytes": total, "manifest": manifest}, nil
}

func (a *App) selectedTheme(ctx context.Context, kind string, page Object) (Object, Object, Object, error) {
	selected := object(page["theme"])
	if selected == nil {
		return nil, nil, nil, nil
	}
	theme, e := a.store.get(ctx, "theme", str(selected, "short"))
	if e != nil {
		return nil, nil, nil, e
	}
	if theme == nil || boolean(theme["deleting"]) {
		return nil, nil, nil, nil
	}
	version, e := a.store.get(ctx, "theme_version", str(theme, "id")+":"+str(selected, "version"))
	if e != nil {
		return nil, nil, nil, e
	}
	if version == nil {
		return nil, nil, nil, nil
	}
	for _, v := range array(object(version["manifest"])["themes"]) {
		definition := object(v)
		if str(definition, "id") == str(selected, "theme") && str(definition, "target") == kind {
			return theme, version, definition, nil
		}
	}
	return nil, nil, nil, nil
}
func (a *App) validatePageTheme(ctx context.Context, kind string, page Object) error {
	if page["theme"] == nil {
		if len(object(page["themeOptions"])) != 0 {
			return failure("theme_unavailable", 409)
		}
		return nil
	}
	_, version, definition, e := a.selectedTheme(ctx, kind, page)
	if e != nil {
		return e
	}
	if definition == nil {
		return failure("theme_unavailable", 409)
	}
	if _, e = os.Stat(filepath.Join(a.config.DataDir, filepath.FromSlash(str(version, "prefix")), filepath.FromSlash(str(definition, "entry")))); e != nil {
		return failure("theme_unavailable", 409)
	}
	specs := map[string]Object{}
	for _, v := range array(definition["options"]) {
		o := object(v)
		specs[str(o, "key")] = o
	}
	for key, value := range object(page["themeOptions"]) {
		o := specs[key]
		if o == nil || !validThemeOption(o, value) {
			return failure("theme_unavailable", 409)
		}
		if kind := str(o, "type"); kind == "monitor" || kind == "agent" {
			row, e := a.store.get(ctx, kind, fmt.Sprint(value))
			if e != nil {
				return e
			}
			if row == nil {
				return failure("theme_unavailable", 409)
			}
		}
	}
	return nil
}
func (a *App) themeValues(ctx context.Context, definition, page Object) Object {
	values := Object{}
	for _, v := range array(definition["options"]) {
		option := object(v)
		key := str(option, "key")
		value := fallback(object(page["themeOptions"]), key, option["default"])
		kind := str(option, "type")
		if kind == "monitor" || kind == "agent" {
			row, _ := a.store.get(ctx, kind, fmt.Sprint(value))
			if row == nil || !boolean(row["is_public"]) || !boolean(row["active"]) {
				value = nil
			}
		}
		values[key] = value
	}
	return values
}

func (a *App) themeRoutes() {
	a.route("GET /api/themes", false, func(w http.ResponseWriter, r *http.Request) error {
		themes, e := a.store.list(r.Context(), "theme")
		if e != nil {
			return e
		}
		versions, e := a.store.list(r.Context(), "theme_version")
		if e != nil {
			return e
		}
		rows := []Object{}
		for _, theme := range themes {
			if boolean(theme["deleting"]) {
				continue
			}
			row := clone(theme)
			row["supported"] = true
			rowVersions := []Object{}
			for _, version := range versions {
				if str(version, "id") != str(theme, "id") {
					continue
				}
				definitions := []Object{}
				for _, v := range array(object(version["manifest"])["themes"]) {
					d := clone(object(v))
					_, e := os.Stat(filepath.Join(a.config.DataDir, filepath.FromSlash(str(version, "prefix")), filepath.FromSlash(str(d, "entry"))))
					d["available"] = e == nil
					definitions = append(definitions, d)
				}
				rowVersions = append(rowVersions, Object{"versionKey": version["versionKey"], "version": version["version"], "prefix": version["prefix"], "themes": definitions})
			}
			row["versions"] = rowVersions
			rows = append(rows, row)
		}
		respond(w, 200, Object{"themes": rows, "storageReady": true})
		return nil
	})
	a.route("POST /api/themes/install", false, func(w http.ResponseWriter, r *http.Request) error {
		var raw []byte
		var e error
		source := ""
		contentType := strings.Split(r.Header.Get("Content-Type"), ";")[0]
		if contains([]string{"application/zip", "application/octet-stream", "application/x-zip-compressed"}, contentType) {
			raw, e = io.ReadAll(io.LimitReader(r.Body, 32<<20+1))
			if e != nil {
				return e
			}
			if len(raw) > 32<<20 {
				return failure("package_too_large", 413)
			}
		} else {
			b, e := body(r)
			if e != nil {
				return e
			}
			source = str(b, "url")
			if source == "" {
				return failure("url_required", 400)
			}
			raw, e = a.downloadTheme(r.Context(), source)
			if e != nil {
				return e
			}
		}
		result, e := a.installTheme(r.Context(), raw, source)
		if e != nil {
			return e
		}
		respond(w, 200, result)
		return nil
	})
	a.route("GET /api/themes/{short}/preview", false, func(w http.ResponseWriter, r *http.Request) error {
		theme, e := a.store.get(r.Context(), "theme", r.PathValue("short"))
		if e != nil {
			return e
		}
		if theme == nil {
			return failure("theme_not_found", 404)
		}
		version, e := a.store.get(r.Context(), "theme_version", str(theme, "id")+":"+r.URL.Query().Get("version"))
		if e != nil {
			return e
		}
		if version == nil {
			return failure("theme_version_not_found", 404)
		}
		for _, v := range array(object(version["manifest"])["themes"]) {
			definition := object(v)
			if str(definition, "id") == r.URL.Query().Get("theme") {
				page := object(object(object(a.presentation(r.Context())["config"])["pages"])[str(definition, "target")])
				if str(object(page["theme"]), "short") != str(theme, "short") || str(object(page["theme"]), "version") != str(version, "versionKey") || str(object(page["theme"]), "theme") != str(definition, "id") {
					page = Object{"themeOptions": Object{}}
				}
				respond(w, 200, Object{"id": theme["id"], "versionKey": version["versionKey"], "prefix": version["prefix"], "manifest": version["manifest"], "definition": definition, "values": a.themeValues(r.Context(), definition, page), "headCode": str(page, "headCode"), "contentHtml": str(page, "contentHtml")})
				return nil
			}
		}
		return failure("theme_unavailable", 409)
	})
	a.route("GET /api/themes/{short}/update-check", false, func(w http.ResponseWriter, r *http.Request) error {
		theme, e := a.store.get(r.Context(), "theme", r.PathValue("short"))
		if e != nil {
			return e
		}
		if theme == nil {
			return failure("theme_not_found", 404)
		}
		if str(theme, "sourceUrl") == "" {
			respond(w, 200, Object{"available": false, "current": theme["version"], "latest": nil, "reason": "no_source_url"})
			return nil
		}
		raw, e := a.downloadTheme(r.Context(), str(theme, "sourceUrl"))
		if e != nil {
			return e
		}
		manifest, _, e := readThemeZip(raw)
		if e != nil {
			return e
		}
		if str(manifest, "id") != str(theme, "id") {
			return failure("theme_id_changed", 409)
		}
		hash := sha256.Sum256(raw)
		digest := hex.EncodeToString(hash[:])
		available := newerVersion(str(manifest, "version"), str(theme, "version")) || str(manifest, "version") == str(theme, "version") && digest != str(theme, "digest")
		respond(w, 200, Object{"available": available, "current": theme["version"], "latest": manifest["version"], "digest": digest})
		return nil
	})
	a.route("DELETE /api/themes/{short}", false, a.deleteTheme)
	a.route("GET /api/public/theme", true, func(w http.ResponseWriter, r *http.Request) error {
		kind, enabled, configured, page, e := a.pageContext(r)
		if e != nil {
			return e
		}
		if enabled && configured {
			theme, version, definition, e := a.selectedTheme(r.Context(), kind, page)
			if e != nil {
				return e
			}
			if definition != nil {
				respond(w, 200, Object{"id": theme["id"], "short": theme["short"], "version": version["version"], "revision": version["versionKey"], "theme": definition["id"]})
				return nil
			}
		}
		respond(w, 200, Object{"id": nil, "short": nil, "version": nil})
		return nil
	})
}
func newerVersion(a, b string) bool {
	for _, suffix := range []string{"+", "-"} {
		a = strings.SplitN(a, suffix, 2)[0]
		b = strings.SplitN(b, suffix, 2)[0]
	}
	aa, bb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3 && i < len(aa) && i < len(bb); i++ {
		x, y := numberString(aa[i], 0), numberString(bb[i], 0)
		if x != y {
			return x > y
		}
	}
	return false
}

func (a *App) deleteTheme(w http.ResponseWriter, r *http.Request) error {
	short := r.PathValue("short")
	theme, e := a.store.get(r.Context(), "theme", short)
	if e != nil {
		return e
	}
	if theme == nil {
		return failure("theme_not_found", 404)
	}
	id := str(theme, "id")
	if !themeIDPattern.MatchString(id) {
		return failure("theme_delete_invalid_path", 409)
	}
	owner := token(16)
	claimed, e := a.store.claim(r.Context(), "theme:"+id, owner, time.Now().Unix(), 120, true)
	if e != nil {
		return e
	}
	if !claimed {
		return failure("theme_busy", 409)
	}
	defer a.store.release(context.Background(), "theme:"+id, owner, 0)
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		state, e := t.get("config", "presentation")
		if e != nil {
			return e
		}
		if state != nil {
			for _, v := range object(object(state["config"])["pages"]) {
				page := object(v)
				if str(object(page["theme"]), "short") == short {
					page["theme"] = nil
					page["themeOptions"] = Object{}
					delete(page, "headCode")
					delete(page, "contentHtml")
				}
			}
			state["revision"] = token(16)
			if e = t.put("config", "presentation", state); e != nil {
				return e
			}
		}
		theme["deleting"] = true
		return t.put("theme", short, theme)
	})
	if e != nil {
		return e
	}
	root, e := filepath.Abs(filepath.Join(a.config.DataDir, "themes"))
	if e != nil {
		return e
	}
	target := filepath.Join(root, id)
	relative, e := filepath.Rel(root, target)
	if e != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return failure("theme_delete_invalid_path", 409)
	}
	if info, e := os.Lstat(target); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return failure("theme_delete_invalid_path", 409)
	}
	if e = os.RemoveAll(target); e != nil {
		return failure("theme_delete_failed", 503)
	}
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		versions, e := t.list("theme_version")
		if e != nil {
			return e
		}
		for _, version := range versions {
			if str(version, "id") == id {
				if e = t.remove("theme_version", id+":"+str(version, "versionKey")); e != nil {
					return e
				}
			}
		}
		return t.remove("theme", short)
	})
	if e != nil {
		return e
	}
	respond(w, 200, Object{"ok": true, "short": short})
	return nil
}

func (a *App) serveThemeAsset(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/theme/"), "/")
	if len(parts) < 6 {
		http.NotFound(w, r)
		return
	}
	prefix := strings.Join(parts[:5], "/")
	file := strings.Join(parts[5:], "/")
	if !prefixPattern.MatchString(prefix) || !safeThemePath(file) {
		http.NotFound(w, r)
		return
	}
	asset := filepath.Join(a.config.DataDir, filepath.FromSlash(prefix), filepath.FromSlash(file))
	info, e := os.Stat(asset)
	if e != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(file)))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	http.ServeFile(w, r, asset)
}
func (a *App) serveThemePage(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != "GET" && r.Method != "HEAD" || !regexp.MustCompile(`^/(?:|monitor/[^/]+|server/[^/]+|status/[^/]+)/?$`).MatchString(r.URL.Path) || r.URL.Query().Get("preview") != "" {
		return false
	}
	maintenance := a.maintenance(r.Context())
	if boolean(maintenance["active"]) {
		if r.URL.Path != "/" {
			http.Redirect(w, r, "/", 302)
			return true
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, maintenanceHTML(maintenance))
		return true
	}
	kind, enabled, configured, page, e := a.pageContext(r)
	if e != nil || !enabled || !configured {
		return false
	}
	_, version, definition, e := a.selectedTheme(r.Context(), kind, page)
	if e != nil || definition == nil {
		return false
	}
	raw, e := os.ReadFile(filepath.Join(a.config.DataDir, filepath.FromSlash(str(version, "prefix")), filepath.FromSlash(str(definition, "entry"))))
	if e != nil {
		return false
	}
	content := regexp.MustCompile(`(?i)<base\b[^>]*>`).ReplaceAllString(string(raw), "")
	directory := path.Dir(str(definition, "entry"))
	if directory == "." {
		directory = ""
	} else {
		directory += "/"
	}
	injection := `<base href="/theme/` + str(version, "prefix") + `/` + directory + `"><script defer src="/polaris-theme-sdk.js" data-capabilities="` + html.EscapeString(strings.Join(stringsOf(definition["capabilities"]), " ")) + `"></script><script defer src="/polaris-maintenance.js" data-locale="auto"></script>`
	head := regexp.MustCompile(`(?i)<head\b[^>]*>`).FindStringIndex(content)
	injection += str(page, "headCode")
	if head != nil {
		content = content[:head[1]] + injection + content[head[1]:]
	} else {
		prefix := regexp.MustCompile(`(?i)^(?:\s*<!doctype[^>]*>)?\s*(?:<html\b[^>]*>)?`).FindStringIndex(content)
		at := prefix[1]
		content = content[:at] + "<head>" + injection + "</head>" + content[at:]
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, content)
	return true
}
