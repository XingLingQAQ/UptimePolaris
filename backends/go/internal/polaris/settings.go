package polaris

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

func defaultSettings() Object {
	return Object{
		"site.title": "Uptime Polaris", "site.description": "服务可用性监控", "site.icon": "/api/public/icon", "site.syncMonitorIcons": false,
		"monitor.defaultIntervalSec": 60, "monitor.defaultTimeoutMs": 10000, "monitor.defaultRetries": 3,
		"retention.availabilityDays": 400, "retention.detailDays": 90, "retention.eventDays": 90,
		"alerts.maintenanceWindows": []any{}, "alerts.maintenanceNote": "", "maintenance.enabled": false, "maintenance.scheduleEnabled": false, "maintenance.announcementTitle": "", "maintenance.announcementDescription": "", "maintenance.title": "", "maintenance.description": "",
		"security.sessionTtlDays": 14, "security.loginMaxAttempts": 8, "security.loginWindowSec": 300, "security.allowAgentCommands": false,
	}
}
func (a *App) settings(ctx context.Context) Object {
	out := defaultSettings()
	stored, e := a.store.get(ctx, "config", "settings")
	if e == nil {
		for k, v := range stored {
			out[k] = v
		}
	}
	return out
}
func validSetting(key string, v any) bool {
	defaults := defaultSettings()
	def, ok := defaults[key]
	if !ok {
		return false
	}
	switch def.(type) {
	case bool:
		_, ok := v.(bool)
		return ok
	case int:
		_, ok := v.(float64)
		if !ok {
			return false
		}
		n := number(v)
		if n != math.Trunc(n) {
			return false
		}
		ranges := map[string][2]float64{"monitor.defaultIntervalSec": {5, 86400}, "monitor.defaultTimeoutMs": {100, 120000}, "monitor.defaultRetries": {0, 10}, "retention.availabilityDays": {7, 3650}, "retention.detailDays": {1, 3650}, "retention.eventDays": {1, 3650}, "security.sessionTtlDays": {1, 365}, "security.loginMaxAttempts": {3, 100}, "security.loginWindowSec": {60, 86400}}
		bounds := ranges[key]
		return n >= bounds[0] && n <= bounds[1]
	case string:
		s, ok := v.(string)
		if !ok {
			return false
		}
		max := 1000
		if key == "site.title" || strings.HasSuffix(key, "Title") || key == "maintenance.title" {
			max = 120
		}
		if key == "site.description" || key == "alerts.maintenanceNote" {
			max = 300
		}
		if key == "site.icon" {
			max = 2048
			if strings.HasPrefix(s, "/") {
				return len(s) <= max
			}
			u, e := url.Parse(s)
			return e == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") && len(s) <= max
		}
		return len(s) <= max && (!strings.HasPrefix(key, "site.") || strings.TrimSpace(s) != "")
	default:
		rows, ok := v.([]any)
		if !ok || len(rows) > 32 {
			return false
		}
		for _, row := range rows {
			if !validWindow(object(row)) {
				return false
			}
		}
		return true
	}
}

var clockPattern = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

func validWindow(o Object) bool {
	if str(o, "kind") == "once" {
		start, e := time.Parse(time.RFC3339Nano, str(o, "startsAt"))
		end, e2 := time.Parse(time.RFC3339Nano, str(o, "endsAt"))
		return e == nil && e2 == nil && end.After(start) && strings.HasSuffix(str(o, "startsAt"), "Z") && strings.HasSuffix(str(o, "endsAt"), "Z")
	}
	return str(o, "kind") == "weekly" && number(o["day"]) >= 0 && number(o["day"]) <= 6 && number(o["day"]) == math.Trunc(number(o["day"])) && clockPattern.MatchString(str(o, "start")) && clockPattern.MatchString(str(o, "end")) && str(o, "start") != str(o, "end")
}
func windowOccurrence(o Object, now time.Time) (time.Time, time.Time) {
	if str(o, "kind") == "once" {
		start, _ := time.Parse(time.RFC3339Nano, str(o, "startsAt"))
		end, _ := time.Parse(time.RFC3339Nano, str(o, "endsAt"))
		return start, end
	}
	now = now.UTC()
	day := int(integer(o, "day"))
	delta := (day - int(now.Weekday()) + 7) % 7
	date := now.AddDate(0, 0, delta).Format("2006-01-02")
	start, _ := time.Parse(time.RFC3339, date+"T"+str(o, "start")+":00Z")
	end, _ := time.Parse(time.RFC3339, date+"T"+str(o, "end")+":00Z")
	if !end.After(start) {
		end = end.Add(24 * time.Hour)
	}
	if start.After(now) {
		priorStart, priorEnd := start.Add(-7*24*time.Hour), end.Add(-7*24*time.Hour)
		if !now.Before(priorStart) && now.Before(priorEnd) {
			return priorStart, priorEnd
		}
	}
	if !end.After(now) {
		start = start.Add(7 * 24 * time.Hour)
		end = end.Add(7 * 24 * time.Hour)
	}
	return start, end
}
func (a *App) maintenance(ctx context.Context) Object {
	s := a.settings(ctx)
	now := time.Now().UTC()
	out := Object{"serverNow": now.Format(time.RFC3339Nano), "active": boolean(s["maintenance.enabled"]), "source": nil, "title": strings.TrimSpace(str(s, "maintenance.title")), "description": strings.TrimSpace(str(s, "maintenance.description")), "startsAt": nil, "endsAt": nil, "scheduled": []Object{}}
	manual := boolean(out["active"])
	if manual {
		out["source"] = "manual"
	}
	periods := []Object{}
	if boolean(s["maintenance.scheduleEnabled"]) {
		for _, v := range array(s["alerts.maintenanceWindows"]) {
			start, end := windowOccurrence(object(v), now)
			if !now.Before(start) && now.Before(end) && !manual {
				out["active"] = true
				out["source"] = "scheduled"
				out["startsAt"] = start.Format(time.RFC3339Nano)
				out["endsAt"] = end.Format(time.RFC3339Nano)
			}
			if start.After(now) {
				periods = append(periods, Object{"title": s["maintenance.announcementTitle"], "description": s["maintenance.announcementDescription"], "startsAt": start.Format(time.RFC3339Nano), "endsAt": end.Format(time.RFC3339Nano)})
			}
		}
	}
	sort.Slice(periods, func(i, j int) bool { return str(periods[i], "startsAt") < str(periods[j], "startsAt") })
	out["scheduled"] = periods
	return out
}

func defaultPresentation() Object {
	return Object{"agentEnabled": false, "workerService": "uptime-polaris", "domains": []any{}, "pages": Object{"monitor": Object{"theme": nil, "themeOptions": Object{}}, "agent": Object{"theme": nil, "themeOptions": Object{}}}}
}
func (a *App) presentation(ctx context.Context) Object {
	o, e := a.store.get(ctx, "config", "presentation")
	if e != nil || o == nil {
		return Object{"config": defaultPresentation(), "revision": "initial"}
	}
	return o
}
func validatePresentation(config Object) bool {
	if config == nil || len(config) != 4 {
		return false
	}
	if _, ok := config["agentEnabled"].(bool); !ok {
		return false
	}
	if !themeIDPattern.MatchString(str(config, "workerService")) {
		return false
	}
	domains, ok := config["domains"].([]any)
	if !ok || len(domains) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, entry := range domains {
		row := object(entry)
		host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(str(row, "hostname")), "."))
		if len(row) != 2 || !hostnamePattern.MatchString(host) || len(host) > 253 || strings.ContainsAny(host, "/:@?#\\") || strings.Contains(host, "..") || seen[host] || !contains([]string{"monitor", "agent"}, str(row, "page")) {
			return false
		}
		seen[host] = true
		row["hostname"] = host
	}
	pages := object(config["pages"])
	if len(pages) != 2 {
		return false
	}
	for _, kind := range []string{"monitor", "agent"} {
		page := object(pages[kind])
		if _, exists := page["theme"]; !exists {
			return false
		}
		if !knownFields(page, []string{"theme", "themeOptions", "headCode", "contentHtml"}) || object(page["themeOptions"]) == nil || len(encode(page["themeOptions"])) > 32000 {
			return false
		}
		for key, limit := range map[string]int{"headCode": 16 << 10, "contentHtml": 32 << 10} {
			if value, exists := page[key]; exists {
				text, ok := value.(string)
				if !ok || len(text) > limit || (page["theme"] == nil && text != "") {
					return false
				}
			}
		}
		if page["theme"] != nil {
			selected := object(page["theme"])
			if len(selected) != 3 || !themeIDPattern.MatchString(str(selected, "short")) || !themeIDPattern.MatchString(str(selected, "theme")) || str(selected, "version") == "" || len(str(selected, "version")) > 160 {
				return false
			}
		}
	}
	return true
}
func (a *App) pageContext(r *http.Request) (string, bool, bool, Object, error) {
	state := a.presentation(r.Context())
	config := object(state["config"])
	kind := "monitor"
	enabled, configured := true, true
	if preview := r.URL.Query().Get("preview"); preview != "" {
		if !contains([]string{"monitor", "agent"}, preview) {
			return "", false, false, nil, failure("invalid_request", 400)
		}
		if !a.authorized(r) {
			return "", false, false, nil, failure("unauthorized", 401)
		}
		kind = preview
		enabled = true
	} else if boolean(config["agentEnabled"]) {
		configured = len(array(config["domains"])) == 0
		host, _, e := netSplitHost(r.Host)
		if e != nil {
			host = r.Host
		}
		for _, v := range array(config["domains"]) {
			domain := object(v)
			if strings.EqualFold(str(domain, "hostname"), host) {
				kind = str(domain, "page")
				configured = true
				break
			}
		}
	}
	return kind, enabled, configured, object(object(config["pages"])[kind]), nil
}
func netSplitHost(host string) (string, string, error) {
	u, e := url.Parse("http://" + host)
	if e != nil {
		return "", "", e
	}
	return u.Hostname(), u.Port(), nil
}

func (a *App) settingsRoutes() {
	a.route("GET /api/admin/settings", false, func(w http.ResponseWriter, r *http.Request) error {
		stored, e := a.store.get(r.Context(), "config", "settings")
		if e != nil {
			return e
		}
		specs := []Object{}
		for k, v := range defaultSettings() {
			kind := "list"
			switch v.(type) {
			case string:
				kind = "string"
			case bool:
				kind = "boolean"
			case int:
				kind = "number"
			}
			_, exists := stored[k]
			specs = append(specs, Object{"key": k, "default": v, "stored": exists, "kind": kind})
		}
		sort.Slice(specs, func(i, j int) bool { return str(specs[i], "key") < str(specs[j], "key") })
		respond(w, 200, Object{"values": a.settings(r.Context()), "invalid": []any{}, "specs": specs})
		return nil
	})
	a.route("PUT /api/admin/settings", false, func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		for k, v := range b {
			if !validSetting(k, v) {
				respond(w, 400, Object{"error": "invalid_setting", "key": k})
				return nil
			}
		}
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			s, e := t.get("config", "settings")
			if e != nil {
				return e
			}
			if s == nil {
				s = Object{}
			}
			for k, v := range b {
				s[k] = v
			}
			return t.put("config", "settings", s)
		})
		if e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true, "values": a.settings(r.Context())})
		return nil
	})
	a.route("DELETE /api/admin/settings/{key}", false, func(w http.ResponseWriter, r *http.Request) error {
		key := r.PathValue("key")
		v, ok := defaultSettings()[key]
		if !ok {
			return failure("unknown_setting", 400)
		}
		e := a.store.mutate(r.Context(), func(t *transaction) error {
			s, e := t.get("config", "settings")
			if e != nil {
				return e
			}
			if s == nil {
				s = Object{}
			}
			delete(s, key)
			return t.put("config", "settings", s)
		})
		if e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true, "value": v})
		return nil
	})
	a.route("GET /api/admin/presentation", false, func(w http.ResponseWriter, r *http.Request) error {
		respond(w, 200, a.presentation(r.Context()))
		return nil
	})
	a.route("PUT /api/admin/presentation", false, func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		config := object(b["config"])
		if len(b) != 2 || !validatePresentation(config) {
			return failure("invalid_presentation", 400)
		}
		for _, kind := range []string{"monitor", "agent"} {
			if e = a.validatePageTheme(r.Context(), kind, object(object(config["pages"])[kind])); e != nil {
				return e
			}
		}
		var state Object
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			for _, v := range object(config["pages"]) {
				page := object(v)
				selected := object(page["theme"])
				if selected == nil {
					continue
				}
				theme, e := t.get("theme", str(selected, "short"))
				if e != nil {
					return e
				}
				if theme == nil || boolean(theme["deleting"]) {
					return failure("theme_unavailable", 409)
				}
				version, e := t.get("theme_version", str(theme, "id")+":"+str(selected, "version"))
				if e != nil {
					return e
				}
				if version == nil {
					return failure("theme_unavailable", 409)
				}
			}
			stored, e := t.get("config", "presentation")
			if e != nil {
				return e
			}
			revision := "initial"
			if stored != nil {
				revision = str(stored, "revision")
			}
			if str(b, "revision") != revision {
				return failure("presentation_conflict", 409)
			}
			oldConfig := defaultPresentation()
			if stored != nil {
				oldConfig = object(stored["config"])
			}
			for _, kind := range []string{"monitor", "agent"} {
				page := object(object(config["pages"])[kind])
				old := object(object(object(oldConfig["pages"])[kind])["theme"])
				next := object(page["theme"])
				if str(old, "short") != str(next, "short") || str(old, "version") != str(next, "version") || str(old, "theme") != str(next, "theme") {
					delete(page, "headCode")
					delete(page, "contentHtml")
				}
			}
			state = Object{"config": config, "revision": token(16)}
			return t.put("config", "presentation", state)
		})
		if e != nil {
			return e
		}
		respond(w, 200, state)
		return nil
	})
	a.route("GET /api/admin/presentation/domains", false, func(w http.ResponseWriter, r *http.Request) error {
		respond(w, 200, Object{"available": false, "reason": "runtime_unsupported", "domains": []string{}})
		return nil
	})
	for _, method := range []string{"GET", "POST", "DELETE"} {
		a.route(method+" /api/admin/site-icon", false, a.siteIcon)
	}
	a.route("GET /api/admin/usage", false, func(w http.ResponseWriter, r *http.Request) error {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		database := Object{"type": "sqlite", "queries": a.store.queries.Load()}
		if a.store.postgres {
			database["type"] = "postgres"
		} else if stat, e := os.Stat(a.config.DatabaseURL); e == nil {
			size := stat.Size()
			for _, suffix := range []string{"-wal", "-shm"} {
				if stat, e := os.Stat(a.config.DatabaseURL + suffix); e == nil {
					size += stat.Size()
				}
			}
			database["sizeBytes"] = size
		}
		respond(w, 200, Object{"runtime": Object{"backend": "go", "uptimeSeconds": int64(time.Since(a.startedAt).Seconds()), "goVersion": runtime.Version(), "goroutines": runtime.NumGoroutine(), "heapAllocBytes": mem.HeapAlloc, "database": database, "themes": Object{"storage": "filesystem"}}})
		return nil
	})
	a.route("POST /api/admin/database-migration/{action}", false, a.databaseMigration)
}

func (a *App) siteIcon(w http.ResponseWriter, r *http.Request) error {
	o, e := a.store.get(r.Context(), "config", "site_icon")
	if e != nil {
		return e
	}
	if r.Method == "DELETE" {
		e = a.store.mutate(r.Context(), func(t *transaction) error { return t.remove("config", "site_icon") })
		if e != nil {
			return e
		}
		o = nil
	}
	if r.Method == "POST" {
		raw, e := io.ReadAll(io.LimitReader(r.Body, 2<<20+1))
		if e != nil {
			return e
		}
		if len(raw) > 2<<20 {
			return failure("too_large", 413)
		}
		contentType := http.DetectContentType(raw)
		if !contains([]string{"image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"}, contentType) {
			return failure("icon_invalid", 400)
		}
		o = Object{"uploaded": true, "contentType": contentType, "byteSize": len(raw), "filename": r.Header.Get("x-filename"), "updatedAt": time.Now().Unix(), "dataUrl": "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(raw), "version": token(16)}
		if e = a.store.put(r.Context(), "config", "site_icon", o); e != nil {
			return e
		}
	}
	if o == nil {
		o = Object{"uploaded": false}
	}
	respond(w, 200, o)
	return nil
}

func (a *App) syncHistory(w http.ResponseWriter, r *http.Request) error {
	if e := a.rollupHistory(r.Context(), true); e != nil {
		return e
	}
	monitors, e := a.store.list(r.Context(), "monitor")
	if e != nil {
		return e
	}
	days, e := a.store.list(r.Context(), "day_stat")
	if e != nil {
		return e
	}
	respond(w, 200, Object{"days": len(days), "attempted": len(monitors), "succeeded": len(monitors), "failed": 0, "monitors": len(monitors), "status": "complete"})
	return nil
}

// 先归档完整 UTC 日再分批删除明细；归档标记避免残余明细覆盖完整统计。
// Archive each full UTC day before batched deletion; markers prevent partial leftovers from replacing complete totals.
func (a *App) rollupHistory(ctx context.Context, force bool) error {
	now := time.Now().Unix()
	owner := token(12)
	claimed, e := a.store.claim(ctx, "history-rollup", owner, now, 120, force)
	if e != nil || !claimed {
		return e
	}
	defer a.store.release(context.Background(), "history-rollup", owner, now+60)
	settings := a.settings(ctx)
	today := now / 86400 * 86400
	cutoff := today - int64(number(settings["retention.detailDays"]))*86400
	return a.store.mutate(ctx, func(t *transaction) error {
		archive := func(day int64) error {
			rows, e := t.tx.Query(t.store.query(`SELECT monitor_id,SUM(CASE WHEN rn=1 THEN 1 ELSE 0 END),SUM(CASE WHEN rn=1 AND status IN (1,4) THEN 1 ELSE 0 END),SUM(CASE WHEN rn=1 AND status=2 THEN 1 ELSE 0 END),AVG(value) FROM (SELECT monitor_id,status,value,ROW_NUMBER() OVER (PARTITION BY monitor_id,ts/60 ORDER BY seq DESC) AS rn FROM polaris_readings WHERE ts>=? AND ts<?) ranked GROUP BY monitor_id`), day, day+86400)
			if e != nil {
				return e
			}
			stats := []Object{}
			for rows.Next() {
				var id string
				var total, up, warn int64
				var avg *float64
				if e = rows.Scan(&id, &total, &up, &warn, &avg); e != nil {
					rows.Close()
					return e
				}
				date := time.Unix(day, 0).UTC().Format("2006-01-02")
				stats = append(stats, Object{"id": id + ":" + date, "monitor_id": id, "d": date, "day_ts": day, "t": total, "u": up, "w": warn, "avg": avg, "exact": true})
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
			for _, stat := range stats {
				monitor, err := t.get("monitor", str(stat, "monitor_id"))
				if err != nil {
					return err
				}
				if monitor != nil {
					if err = t.put("day_stat", str(stat, "id"), stat); err != nil {
						return err
					}
				}
			}
			return t.put("rollup_day", fmt.Sprint(day), Object{"day_ts": day})
		}
		var oldest sql.NullInt64
		if e := t.tx.QueryRow(t.store.query(`SELECT MIN(ts) FROM polaris_readings WHERE ts<?`), cutoff).Scan(&oldest); e != nil {
			return e
		}
		if oldest.Valid {
			day := oldest.Int64 / 86400 * 86400
			marker, e := t.get("rollup_day", fmt.Sprint(day))
			if e != nil {
				return e
			}
			if marker == nil {
				if e = archive(day); e != nil {
					return e
				}
			}
			if _, e = t.tx.Exec(t.store.query(`DELETE FROM polaris_readings WHERE seq IN (SELECT seq FROM polaris_readings WHERE ts>=? AND ts<? ORDER BY ts,seq LIMIT 5000)`), day, day+86400); e != nil {
				return e
			}
			var remaining bool
			if e = t.tx.QueryRow(t.store.query(`SELECT EXISTS(SELECT 1 FROM polaris_readings WHERE ts>=? AND ts<?)`), day, day+86400).Scan(&remaining); e != nil {
				return e
			}
			if !remaining {
				if e = t.remove("rollup_day", fmt.Sprint(day)); e != nil {
					return e
				}
			}
		}
		processed := 0
		for day := today - 86400; day >= cutoff; day -= 86400 {
			marker, e := t.get("rollup_day", fmt.Sprint(day))
			if e != nil {
				return e
			}
			if marker != nil {
				continue
			}
			if e = archive(day); e != nil {
				return e
			}
			processed++
			if !force && processed >= 7 {
				break
			}
		}
		for kind, field := range map[string]string{"probe_job": "scheduled_at", "command": "queued_at"} {
			stamp := `CAST(COALESCE(` + t.store.jsonField(field) + `,'0') AS BIGINT)`
			query := `DELETE FROM polaris_documents WHERE kind=? AND id IN (SELECT id FROM polaris_documents WHERE kind=? AND ` + stamp + `<? ORDER BY ` + stamp + `,id LIMIT 5000)`
			if _, e := t.tx.Exec(t.store.query(query), kind, kind, now-86400); e != nil {
				return e
			}
		}
		for _, kind := range []string{"day_stat", "machine_history", "event", "delivery", "session", "login_limit", "outbox"} {
			rows, e := t.tx.Query(t.store.query(`SELECT id,data FROM polaris_documents WHERE kind=?`), kind)
			if e != nil {
				return e
			}
			ids := []string{}
			expiredPending := []Object{}
			for rows.Next() {
				var id, raw string
				if e = rows.Scan(&id, &raw); e != nil {
					rows.Close()
					return e
				}
				o, e := decodeObject(raw)
				if e != nil {
					rows.Close()
					return e
				}
				expired := false
				switch kind {
				case "day_stat":
					expired = integer(o, "day_ts") < now-int64(number(settings["retention.availabilityDays"]))*86400
				case "machine_history":
					expired = integer(o, "bucket_ts") < now-86400
				case "event":
					expired = integer(o, "created_at") < now-int64(number(settings["retention.eventDays"]))*86400
				case "delivery":
					expired = integer(o, "created_at") < now-90*86400
				case "session":
					expired = integer(o, "expires_at") < now
				case "login_limit":
					expired = integer(o, "started") < now-86400
				case "outbox":
					if str(o, "state") == "pending" && integer(o, "created_at") <= now-7*86400 {
						o["state"] = "failed"
						expiredPending = append(expiredPending, o)
					} else {
						expired = str(o, "state") != "pending" && integer(o, "next_at") < now-86400
					}
				}
				if expired {
					ids = append(ids, id)
				}
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
			for _, row := range expiredPending {
				if e = t.put("outbox", str(row, "id"), row); e != nil {
					return e
				}
			}
			for _, id := range ids {
				if e = t.remove(kind, id); e != nil {
					return e
				}
			}
		}
		return nil
	})
}

func (a *App) tags(ctx context.Context, kind string, ids []string) []Object {
	out := []Object{}
	for _, id := range ids {
		tag, e := a.store.get(ctx, kind, id)
		if e == nil && tag != nil {
			out = append(out, Object{"id": tag["id"], "tag_id": tag["id"], "name": tag["name"], "color": tag["color"]})
		}
	}
	return out
}
func publicTarget(target string) string {
	if target == "" {
		return ""
	}
	u, e := url.Parse(target)
	if e == nil && u.Host != "" {
		u.User = nil
		u.RawQuery = ""
		u.Fragment = ""
		return u.String()
	}
	u, e = url.Parse("http://" + target)
	if e == nil && u.Host != "" {
		return u.Host + strings.TrimSuffix(u.EscapedPath(), "/")
	}
	return "Invalid URL"
}
func publicMessage(kind string, status int64, message string) string {
	if message == "" {
		return ""
	}
	switch status {
	case 0:
		return strings.ToUpper(kind) + " check failed"
	case 2:
		return "Monitor warning"
	case 4:
		return "Check pending"
	}
	return ""
}
func iso(ts int64) string { return time.Unix(ts, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func fmtID(v any) string  { return fmt.Sprint(v) }
