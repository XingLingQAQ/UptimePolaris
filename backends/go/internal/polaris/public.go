package polaris

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type reading struct {
	seq, ts int64
	status  int
	value   *float64
	code    int
	message string
	addons  Object
}

func publicCountry(value any) any {
	raw, ok := value.(string)
	if !ok {
		return nil
	}
	parts := strings.Split(raw, ",")
	code := strings.TrimSpace(parts[len(parts)-1])
	if len(code) != 2 {
		return nil
	}
	for _, r := range code {
		if (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') {
			return nil
		}
	}
	return strings.ToUpper(code)
}

func publicPageCountry(page Object) bool {
	if value, ok := page["showCountry"].(bool); ok {
		return value
	}
	return true
}

func (a *App) readings(ctx context.Context, id string, since int64, limit int) ([]reading, error) {
	rows, e := a.store.db.QueryContext(ctx, a.store.query(`SELECT seq,ts,status,value,code,message,addons FROM polaris_readings WHERE monitor_id=? AND ts>=? ORDER BY ts DESC,seq DESC LIMIT ?`), id, since, limit)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []reading{}
	for rows.Next() {
		var r reading
		var value sql.NullFloat64
		var addons string
		if e = rows.Scan(&r.seq, &r.ts, &r.status, &value, &r.code, &r.message, &addons); e != nil {
			return nil, e
		}
		if value.Valid {
			r.value = &value.Float64
		}
		r.addons, _ = decodeObject(addons)
		out = append(out, r)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, rows.Err()
}
func ringOf(points []reading, public bool, kind string) []Object {
	out := []Object{}
	for _, point := range points {
		var value any
		if point.value != nil && kind != "push" {
			value = *point.value
		}
		msg := point.message
		if public {
			msg = publicMessage(kind, int64(point.status), msg)
		}
		out = append(out, Object{"t": point.ts, "up": point.status, "ms": value, "msg": msg})
	}
	return out
}
func dailyOf(points []reading) []Object {
	byDay := map[string]Object{}
	sums := map[string]float64{}
	counts := map[string]int{}
	latest := map[int64]reading{}
	for _, r := range points {
		d := time.Unix(r.ts, 0).UTC().Format("2006-01-02")
		if r.value != nil {
			sums[d] += *r.value
			counts[d]++
		}
		minute := r.ts / 60
		old, exists := latest[minute]
		if !exists || r.seq >= old.seq {
			latest[minute] = r
		}
	}
	for _, r := range latest {
		d := time.Unix(r.ts, 0).UTC().Format("2006-01-02")
		row := byDay[d]
		if row == nil {
			row = Object{"d": d, "t": 0, "u": 0, "w": 0, "avg": nil, "exact": true}
			byDay[d] = row
		}
		row["t"] = integer(row, "t") + 1
		if r.status == 1 || r.status == 4 {
			row["u"] = integer(row, "u") + 1
		}
		if r.status == 2 {
			row["w"] = integer(row, "w") + 1
		}
	}
	keys := []string{}
	for d := range byDay {
		keys = append(keys, d)
	}
	sort.Strings(keys)
	out := []Object{}
	for _, d := range keys {
		row := byDay[d]
		if counts[d] > 0 {
			row["avg"] = sums[d] / float64(counts[d])
		}
		out = append(out, row)
	}
	return out
}

func (a *App) history(ctx context.Context, id string, points []reading) []Object {
	byDate := map[string]Object{}
	today := time.Now().UTC().Format("2006-01-02")
	for _, day := range dailyOf(points) {
		if str(day, "d") < today {
			byDate[str(day, "d")] = day
		}
	}
	stored, _ := a.store.list(ctx, "day_stat")
	for _, day := range stored {
		if str(day, "monitor_id") == id {
			byDate[str(day, "d")] = project(day, []string{"d", "t", "u", "w", "avg", "exact"})
		}
	}
	keys := []string{}
	for d := range byDate {
		keys = append(keys, d)
	}
	sort.Strings(keys)
	if len(keys) > 90 {
		keys = keys[len(keys)-90:]
	}
	out := []Object{}
	for _, d := range keys {
		out = append(out, byDate[d])
	}
	return out
}
func overall(days []Object) any {
	total, up := float64(0), float64(0)
	for _, d := range days {
		total += number(d["t"])
		up += number(d["u"]) + number(d["w"])
	}
	if total == 0 {
		return nil
	}
	return math.Round(up/total*10000) / 100
}
func rolling(points []reading, now, interval int64) (any, float64) {
	start := now - 86400
	covered, up := int64(0), int64(0)
	for i, r := range points {
		end := r.ts + interval
		if i+1 < len(points) && points[i+1].ts < end {
			end = points[i+1].ts
		}
		if end > now {
			end = now
		}
		begin := r.ts
		if begin < start {
			begin = start
		}
		if end <= begin {
			continue
		}
		covered += end - begin
		if r.status == 1 || r.status == 2 || r.status == 4 {
			up += end - begin
		}
	}
	if covered == 0 {
		return nil, 0
	}
	return float64(up) / float64(covered), math.Min(1, float64(covered)/86400)
}

func (a *App) source(ctx context.Context, m, live Object) Object {
	kind, id := checkSource(m)
	out := Object{"source": kind, "source_available": true, "source_pending": false, "source_last_observed_at": nil}
	if str(m, "type") == "push" || str(m, "type") == "agent" {
		out["source"] = str(m, "type")
		return out
	}
	if kind == "agent" {
		agent, _ := a.store.get(ctx, "agent", id)
		machine, _ := a.store.get(ctx, "machine", id)
		online := agentOnline(machine, time.Now().Unix())
		available := agent != nil && boolean(agent["active"]) && boolean(agent["probe_enabled"]) && online != nil && *online && contains(stringsOf(machine["capabilities"]), "probe_"+str(m, "type"))
		out["source_available"] = available
		out["source_id"] = id
		out["source_name"] = agent["name"]
		if live == nil {
			out["source_pending"] = available
		} else {
			out["source_last_observed_at"] = live["ts"]
			if time.Now().Unix()-integer(live, "ts") > max(180, integer(m, "interval_sec")*3) {
				out["source_available"] = false
			}
		}
	}
	return out
}

func (a *App) overview(w http.ResponseWriter, r *http.Request) error {
	monitors, e := a.store.list(r.Context(), "monitor")
	if e != nil {
		return e
	}
	counts := Object{"total": len(monitors), "up": 0, "warn": 0, "down": 0, "pending": 0, "paused": 0}
	rows := []Object{}
	for _, m := range monitors {
		live, e := a.store.get(r.Context(), "live", str(m, "id"))
		if e != nil {
			return e
		}
		points, e := a.readings(r.Context(), str(m, "id"), time.Now().Unix()-86400, 50000)
		if e != nil {
			return e
		}
		days := a.history(r.Context(), str(m, "id"), points)
		row := clone(m)
		row["tags"] = a.tags(r.Context(), "tag", stringsOf(m["tag_ids"]))
		delete(row, "tag_ids")
		row["st"] = nil
		row["msg"] = ""
		row["v"] = nil
		row["checked_at"] = 0
		if live != nil {
			row["st"] = live["st"]
			row["msg"] = live["msg"]
			row["v"] = live["v"]
			row["checked_at"] = live["ts"]
			for _, kind := range []string{"ssl", "domain", "dns"} {
				if boolean(m["check_"+kind]) && live[kind] != nil {
					row[kind] = live[kind]
				}
			}
		}
		if str(m, "type") == "push" {
			push, _ := a.store.get(r.Context(), "push", str(m, "id"))
			row["push_last_received_at"] = push["ts"]
		}
		for k, v := range a.source(r.Context(), m, live) {
			row[k] = v
		}
		row["uptime"] = overall(days)
		row["has_history"] = len(days) > 0
		row["days"] = days
		if len(points) > 120 {
			points = points[len(points)-120:]
		}
		row["ring"] = ringOf(points, false, str(m, "type"))
		rows = append(rows, row)
		key := ""
		if !boolean(m["active"]) {
			key = "paused"
		} else if live != nil {
			key = map[int64]string{0: "down", 1: "up", 2: "warn", 4: "pending"}[integer(live, "st")]
		}
		if key != "" {
			counts[key] = integer(counts, key) + 1
		}
	}
	sort.Slice(rows, func(i, j int) bool { return integer(rows[i], "num_id") < integer(rows[j], "num_id") })
	settings, e := a.settings(r.Context())
	if e != nil {
		return e
	}
	respond(w, 200, Object{"monitors": rows, "counts": counts, "now": time.Now().Unix(), "defaults": Object{"interval_sec": settings["monitor.defaultIntervalSec"], "timeout_ms": settings["monitor.defaultTimeoutMs"]}})
	return nil
}

func (a *App) events(w http.ResponseWriter, r *http.Request) error {
	rows, e := a.store.list(r.Context(), "event")
	if e != nil {
		return e
	}
	sort.Slice(rows, func(i, j int) bool { return integer(rows[i], "id") > integer(rows[j], "id") })
	limit := queryLimit(r, 20, 100)
	cursor := r.URL.Query().Get("before")
	if cursor != "" {
		parts := strings.Split(cursor, ":")
		if len(parts) != 2 {
			return failure("invalid_cursor", 400)
		}
		ts, e := strconv.ParseInt(parts[0], 10, 64)
		id, e2 := strconv.ParseInt(parts[1], 10, 64)
		if e != nil || e2 != nil || id < 1 {
			return failure("invalid_cursor", 400)
		}
		filtered := []Object{}
		for _, row := range rows {
			if integer(row, "created_at") < ts || integer(row, "created_at") == ts && integer(row, "id") < id {
				filtered = append(filtered, row)
			}
		}
		rows = filtered
	}
	var next any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = fmt.Sprintf("%d:%d", integer(last, "created_at"), integer(last, "id"))
	}
	respond(w, 200, Object{"events": rows, "nextCursor": next})
	return nil
}
func queryLimit(r *http.Request, def, max int) int {
	n, e := strconv.Atoi(r.URL.Query().Get("limit"))
	if e != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// 先确认监控页面可用，再仅返回已启用且公开的监控。
// Require an available monitor page, then return only active public monitors.
func (a *App) pageMonitors(r *http.Request) ([]Object, error) {
	kind, enabled, configured, _, e := a.pageContext(r)
	if e != nil {
		return nil, e
	}
	if kind != "monitor" || !enabled || !configured {
		return nil, failure("not_found", 404)
	}
	rows, e := a.store.list(r.Context(), "monitor")
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, m := range rows {
		if boolean(m["is_public"]) && boolean(m["active"]) {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return integer(out[i], "num_id") < integer(out[j], "num_id") })
	return out, nil
}
func (a *App) publicMonitorRow(ctx context.Context, m Object) (Object, []reading, error) {
	live, e := a.store.get(ctx, "live", str(m, "id"))
	if e != nil {
		return nil, nil, e
	}
	points, e := a.readings(ctx, str(m, "id"), time.Now().Unix()-86400, 50000)
	if e != nil {
		return nil, nil, e
	}
	days := a.history(ctx, str(m, "id"), points)
	row := Object{"id": m["id"], "num_id": m["num_id"], "name": m["name"], "type": m["type"], "target": publicTarget(str(m, "target")), "active": m["active"], "st": 4, "msg": "", "v": nil, "group_id": m["group_id"], "group": nil, "is_ungrouped": true, "tags": a.tags(ctx, "tag", stringsOf(m["tag_ids"])), "days": days, "uptime": overall(days)}
	if group, _ := a.store.get(ctx, "group", str(m, "group_id")); group != nil {
		row["group"] = group["name"]
		row["is_ungrouped"] = false
	}
	if live != nil {
		row["st"] = live["st"]
		row["msg"] = publicMessage(str(m, "type"), integer(live, "st"), str(live, "msg"))
		if str(m, "type") != "push" {
			row["v"] = live["v"]
		}
	}
	// 公开状态只含来源状态，不暴露内部 Agent 身份。
	// Publish source status without exposing the internal Agent identity.
	source := a.source(ctx, m, live)
	for _, key := range []string{"source", "source_available", "source_pending", "source_last_observed_at"} {
		row[key] = source[key]
	}
	if !boolean(row["source_available"]) {
		row["st"] = nil
		row["v"] = nil
		row["uptime"] = nil
		row["msg"] = "source unavailable"
	}
	recent := points
	if len(recent) > 120 {
		recent = recent[len(recent)-120:]
	}
	row["ring"] = ringOf(recent, true, str(m, "type"))
	badges := []Object{}
	for _, kind := range []string{"ssl", "domain"} {
		if boolean(m["check_"+kind]) {
			if addon := object(live[kind]); addon != nil {
				badges = append(badges, Object{"kind": kind, "days": addon["days"], "status": addon["st"], "message": publicMessage(kind, integer(addon, "st"), str(addon, "msg"))})
			}
		}
	}
	row["expiryBadges"] = badges
	if boolean(m["check_dns"]) {
		if dns := object(live["dns"]); dns != nil {
			row["dns"] = Object{"st": dns["st"], "ts": dns["ts"], "records": dns["records"], "msg": publicMessage("dns", integer(dns, "st"), str(dns, "msg"))}
		}
	}
	return row, points, nil
}

func (a *App) publicRoutes() {
	a.route("GET /api/public/health", true, func(w http.ResponseWriter, r *http.Request) error {
		if e := a.store.db.PingContext(r.Context()); e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true, "ts": time.Now().UnixMilli()})
		return nil
	})
	a.route("GET /api/public/maintenance", true, func(w http.ResponseWriter, r *http.Request) error {
		settings, e := a.settings(r.Context())
		if e != nil {
			return e
		}
		respond(w, 200, maintenance(settings))
		return nil
	})
	a.route("GET /api/public/config", true, a.publicConfig)
	a.route("GET /api/public/status", true, func(w http.ResponseWriter, r *http.Request) error {
		monitors, e := a.pageMonitors(r)
		if e != nil {
			return e
		}
		rows := []Object{}
		for _, m := range monitors {
			row, _, e := a.publicMonitorRow(r.Context(), m)
			if e != nil {
				return e
			}
			rows = append(rows, row)
		}
		respond(w, 200, Object{"now": time.Now().Unix(), "monitors": rows})
		return nil
	})
	a.route("GET /api/public/monitors", true, a.publicMonitors)
	a.route("GET /api/public/monitors/{num}", true, a.publicMonitorDetail)
	a.route("GET /api/public/status/detail", true, a.publicMonitorDetail)
	a.route("GET /api/recent/{id}", true, a.publicMonitorDetail)
	a.route("GET /api/public/push/{token}", true, func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Allow", "POST")
		respond(w, 405, Object{"error": "method_not_allowed", "hint": "send this heartbeat with POST"})
		return nil
	})
	a.route("POST /api/public/push/{token}", true, func(w http.ResponseWriter, r *http.Request) error {
		rows, e := a.store.list(r.Context(), "monitor")
		if e != nil {
			return e
		}
		for _, m := range rows {
			if str(m, "type") == "push" && constantEqual(str(m, "push_token"), r.PathValue("token")) {
				status := 1
				switch r.URL.Query().Get("status") {
				case "0":
					status = 0
				case "2":
					status = 2
				}
				msg := r.URL.Query().Get("msg")
				if len(msg) > 1024 {
					msg = msg[:1024]
				}
				if e = a.store.put(r.Context(), "push", str(m, "id"), Object{"ts": time.Now().Unix(), "status": status, "message": msg}); e != nil {
					return e
				}
				respond(w, 200, Object{"ok": true})
				return nil
			}
		}
		return failure("unknown_token", 404)
	})
	a.route("GET /api/public/icon", true, a.publicIcon)
	a.route("GET /api/public/monitor-icon", true, a.monitorIcon)
	a.route("GET /api/public/servers", true, a.publicServers)
	a.route("GET /api/public/servers/{id}", true, a.publicServers)
	a.route("GET /api/public/agent/detail/{num}", true, a.publicAgentDetail)
}

func (a *App) publicConfig(w http.ResponseWriter, r *http.Request) error {
	if fresh := r.URL.Query().Get("fresh"); fresh != "" && fresh != "1" {
		return failure("invalid_request", 400)
	}
	kind, enabled, configured, page, e := a.pageContext(r)
	if e != nil {
		return e
	}
	s, e := a.settings(r.Context())
	if e != nil {
		return e
	}
	meta := Object{"title": s["site.title"], "description": s["site.description"], "icon": s["site.icon"], "iconCandidates": []any{s["site.icon"]}}
	pageID := r.URL.Query().Get("pageId")
	if pageID == "" {
		pageID = "default"
	}
	maintenance := maintenance(s)
	notices := maintenanceNotices(s)
	layout := "list"
	if kind == "agent" {
		layout = "cards"
	}
	result := Object{"pageId": pageID, "pageIds": []string{pageID}, "defaultPageId": pageID, "siteMeta": meta, "pages": []Object{{"id": pageID, "siteMeta": meta}}, "isPlaceholder": false, "isEditThisPage": false, "isShowStarButton": false, "config": Object{"slug": pageID, "title": s["site.title"], "description": s["site.description"], "icon": s["site.icon"], "theme": "system", "published": true, "showTags": true, "customCSS": "", "footerText": "", "showPoweredBy": false, "googleAnalyticsId": nil, "showCertificateExpiry": true}, "publicGroupList": []any{}, "maintenanceList": notices, "maintenance": maintenance, "incidents": []any{}, "success": true, "status": "ok", "pageTabs": []any{}, "matrixStatus": "ok", "timestamp": time.Now().UnixMilli(), "presentation": Object{"kind": kind, "enabled": enabled, "configured": configured, "layout": layout, "density": "normal", "columns": 3, "width": 1440, "accent": "#6366F1", "colorMode": "system", "showHistory": true, "showLatency": true, "showAvailability": true, "showExpiry": true, "showCountry": publicPageCountry(page), "locale": "auto"}}
	result["theme"] = nil
	result["theme_settings"] = nil
	result["theme_content_html"] = nil
	if enabled && configured {
		theme, version, definition, err := a.selectedTheme(r.Context(), kind, page)
		if err != nil {
			return err
		}
		if definition != nil {
			result["theme"] = Object{"short": theme["short"], "name": definition["name"], "version": version["versionKey"]}
			result["theme_settings"] = a.themeValues(r.Context(), definition, page)
			result["theme_content_html"] = str(page, "contentHtml")
		}
	}
	respond(w, 200, result)
	return nil
}

func (a *App) publicMonitors(w http.ResponseWriter, r *http.Request) error {
	monitors, e := a.pageMonitors(r)
	if e != nil {
		return e
	}
	groups, e := a.store.list(r.Context(), "group")
	if e != nil {
		return e
	}
	sort.Slice(groups, func(i, j int) bool {
		wi, wj := integer(groups[i], "weight"), integer(groups[j], "weight")
		if wi == wj {
			return str(groups[i], "name") < str(groups[j], "name")
		}
		return wi < wj
	})
	byGroup := map[string][]Object{}
	heartbeat, uptime, coverage := Object{}, Object{}, Object{}
	for _, m := range monitors {
		row, points, e := a.publicMonitorRow(r.Context(), m)
		if e != nil {
			return e
		}
		id := fmt.Sprint(m["num_id"])
		entry := Object{"id": m["num_id"], "name": m["name"], "sendUrl": 0, "type": m["type"], "url": row["target"], "expiryBadges": row["expiryBadges"], "tags": row["tags"]}
		if row["dns"] != nil {
			entry["dns"] = row["dns"]
		}
		source, _ := checkSource(m)
		if str(m, "type") != "push" && str(m, "type") != "agent" {
			entry["source"] = source
			entry["sourceAvailable"] = row["source_available"]
			if source == "agent" {
				entry["sourcePending"] = row["source_pending"]
				entry["sourceLastObservedAt"] = row["source_last_observed_at"]
			}
		}
		if str(m, "type") == "push" {
			push, _ := a.store.get(r.Context(), "push", str(m, "id"))
			entry["pushLastReceivedAt"] = push["ts"]
			entry["intervalSec"] = m["interval_sec"]
		}
		byGroup[str(m, "group_id")] = append(byGroup[str(m, "group_id")], entry)
		ratio, cov := rolling(points, time.Now().Unix(), integer(m, "interval_sec"))
		if len(points) > 120 {
			points = points[len(points)-120:]
		}
		beats := []Object{}
		for _, point := range points {
			var ping any
			if point.value != nil && str(m, "type") != "push" {
				ping = *point.value
			}
			beats = append(beats, Object{"status": point.status, "time": iso(point.ts), "msg": "", "ping": ping})
		}
		heartbeat[id] = beats
		uptime[id+"_24"] = ratio
		coverage[id+"_24"] = cov
	}
	groupRows := []Object{}
	known := map[string]bool{}
	for _, g := range groups {
		id := str(g, "id")
		known[id] = true
		if len(byGroup[id]) > 0 {
			groupRows = append(groupRows, Object{"id": g["num_id"], "name": g["name"], "weight": g["weight"], "monitorList": byGroup[id]})
		}
	}
	ungrouped := []Object{}
	for id, list := range byGroup {
		if !known[id] {
			ungrouped = append(ungrouped, list...)
		}
	}
	groupRows = append(groupRows, Object{"id": 0, "name": nil, "isUngrouped": true, "weight": 9007199254740991, "monitorList": ungrouped})
	respond(w, 200, Object{"success": true, "monitorGroups": groupRows, "data": Object{"heartbeatList": heartbeat, "uptimeList": uptime, "uptimeCoverage": coverage}, "timestamp": time.Now().UnixMilli()})
	return nil
}

func (a *App) publicMonitorDetail(w http.ResponseWriter, r *http.Request) error {
	monitors, e := a.pageMonitors(r)
	if e != nil {
		return e
	}
	var selected Object
	num, _ := strconv.ParseInt(r.PathValue("num"), 10, 64)
	id := r.PathValue("id")
	if id == "" {
		id = r.URL.Query().Get("id")
	}
	for _, m := range monitors {
		if num > 0 && integer(m, "num_id") == num || id != "" && str(m, "id") == id {
			selected = m
			break
		}
	}
	if selected == nil {
		return failure("not_found", 404)
	}
	row, _, e := a.publicMonitorRow(r.Context(), selected)
	if e != nil {
		return e
	}
	if r.URL.Path == "/api/public/status/detail" {
		respond(w, 200, Object{"id": selected["id"], "days": row["days"]})
		return nil
	}
	if strings.HasPrefix(r.URL.Path, "/api/recent/") {
		live, _ := a.store.get(r.Context(), "live", str(selected, "id"))
		if live == nil {
			respond(w, 200, Object{"st": nil})
		} else {
			respond(w, 200, Object{"st": live["st"], "ts": live["ts"], "v": row["v"], "code": live["code"], "msg": row["msg"]})
		}
		return nil
	}
	row["uuid"] = selected["id"]
	row["id"] = selected["num_id"]
	respond(w, 200, row)
	return nil
}

func maintenanceNotices(s Object) []Object {
	out := []Object{}
	if !boolean(s["maintenance.scheduleEnabled"]) {
		return out
	}
	now := time.Now().UTC()
	for i, v := range array(s["alerts.maintenanceWindows"]) {
		start, end := windowOccurrence(object(v), now)
		if !end.After(now) {
			continue
		}
		active := !now.Before(start) && now.Before(end)
		status := "scheduled"
		if active {
			status = "under-maintenance"
		}
		title := str(s, "maintenance.announcementTitle")
		if title == "" {
			title = start.Format("15:04") + "–" + end.Format("15:04") + " UTC"
		}
		out = append(out, Object{"id": i + 1, "title": title, "description": s["maintenance.announcementDescription"], "strategy": "scheduled", "intervalDay": 1, "active": true, "dateRange": []string{iso(start.Unix()), iso(end.Unix())}, "timeRange": []Object{{"hours": start.Hour(), "minutes": start.Minute()}, {"hours": end.Hour(), "minutes": end.Minute()}}, "weekdays": []any{}, "daysOfMonth": []any{}, "timeslotList": []Object{{"startDate": iso(start.Unix()), "endDate": iso(end.Unix())}}, "cron": "", "durationMinutes": end.Sub(start).Minutes(), "timezone": "UTC", "timezoneOption": "UTC", "timezoneOffset": "+00:00", "status": status})
	}
	return out
}

func (a *App) publicIcon(w http.ResponseWriter, r *http.Request) error {
	o, e := a.store.get(r.Context(), "config", "site_icon")
	if e != nil {
		return e
	}
	if o != nil {
		parts := strings.SplitN(str(o, "dataUrl"), ",", 2)
		if len(parts) == 2 {
			raw, e := base64.StdEncoding.DecodeString(parts[1])
			if e == nil {
				w.Header().Set("Cache-Control", "public, max-age=60, must-revalidate")
				w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
				etag := `"` + str(o, "version") + `"`
				w.Header().Set("ETag", etag)
				if r.Header.Get("If-None-Match") == etag {
					w.WriteHeader(304)
					return nil
				}
				w.Header().Set("Content-Type", str(o, "contentType"))
				_, e = w.Write(raw)
				return e
			}
		}
	}
	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400")
	_, e = io.WriteString(w, brandIcon(r))
	return e
}
func (a *App) monitorIcon(w http.ResponseWriter, r *http.Request) error {
	settings, e := a.settings(r.Context())
	if e != nil {
		return e
	}
	if !boolean(settings["site.syncMonitorIcons"]) {
		return failure("not_found", 404)
	}
	monitors, e := a.pageMonitors(r)
	if e != nil {
		return e
	}
	num, _ := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	for _, m := range monitors {
		if integer(m, "num_id") == num && str(m, "type") == "http" {
			u, _ := url.Parse(str(m, "target"))
			if !publicHost(r.Context(), u.Hostname()) {
				return failure("not_found", 404)
			}
			u.User = nil
			u.Path = "/favicon.ico"
			u.RawQuery = ""
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
			client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) > 3 || !publicHost(ctx, req.URL.Hostname()) {
					return fmt.Errorf("unsafe redirect")
				}
				return nil
			}}
			response, e := client.Do(req)
			if e != nil {
				return failure("not_found", 404)
			}
			defer response.Body.Close()
			raw, e := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
			if e != nil || response.StatusCode != 200 || len(raw) > 256*1024 || !strings.HasPrefix(http.DetectContentType(raw), "image/") {
				return failure("not_found", 404)
			}
			w.Header().Set("Content-Type", http.DetectContentType(raw))
			_, e = w.Write(raw)
			return e
		}
	}
	return failure("not_found", 404)
}
func publicHost(ctx context.Context, host string) bool {
	addresses, e := net.DefaultResolver.LookupIPAddr(ctx, host)
	if e != nil || len(addresses) == 0 {
		return false
	}
	for _, address := range addresses {
		ip := address.IP
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			return false
		}
	}
	return true
}
