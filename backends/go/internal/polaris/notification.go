package polaris

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

//go:embed notification-copy.json
var notificationCopyJSON []byte
var notificationCopy = func() map[string]Object {
	var copy map[string]Object
	if e := json.Unmarshal(notificationCopyJSON, &copy); e != nil {
		panic(e)
	}
	return copy
}()
var notificationTypes = []string{"telegram", "feishu", "slack", "discord", "webhook", "apprise", "serverchan"}

func notificationConfigError(kind string, config Object) string {
	if value, ok := config["language"]; ok && notificationCopy[fmt.Sprint(value)] == nil {
		return "notification_language_invalid"
	}
	required := func(key, code string) string {
		if strings.TrimSpace(str(config, key)) == "" {
			return code
		}
		return ""
	}
	switch kind {
	case "telegram":
		if code := required("bot_token", "telegram_token_required"); code != "" {
			return code
		}
		return required("chat_id", "telegram_chat_required")
	case "serverchan":
		if str(config, "sendkey") == "" {
			return "serverchan_key_required"
		}
		if !regexp.MustCompile(`^sctp\d+t[A-Za-z0-9_-]+$`).MatchString(str(config, "sendkey")) {
			return "serverchan_key_invalid"
		}
		return ""
	default:
		key := "url"
		if contains([]string{"feishu", "slack", "discord"}, kind) {
			key = "webhook_url"
		}
		if str(config, key) == "" {
			return kind + "_url_required"
		}
		u, e := url.Parse(str(config, key))
		if e != nil || u.Scheme != "https" || u.Host == "" {
			return kind + "_url_invalid"
		}
		if kind == "apprise" && str(config, "key") == "" && str(config, "urls") == "" {
			return "apprise_urls_required"
		}
		return ""
	}
}

func (a *App) notificationRoutes() {
	a.route("GET /api/notifications", false, func(w http.ResponseWriter, r *http.Request) error {
		rows, e := a.store.list(r.Context(), "notification")
		if e != nil {
			return e
		}
		respond(w, 200, Object{"channels": rows})
		return nil
	})
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		pattern := method + " /api/notifications"
		if method != "POST" {
			pattern += "/{id}"
		}
		a.route(pattern, false, a.notificationWrite)
	}
	a.route("POST /api/notifications/{id}/test", false, func(w http.ResponseWriter, r *http.Request) error {
		channel, e := a.store.get(r.Context(), "notification", r.PathValue("id"))
		if e != nil {
			return e
		}
		if channel == nil {
			return failure("not_found", 404)
		}
		copy := notificationCopy[str(object(channel["config"]), "language")]
		if copy == nil {
			copy = notificationCopy["en-US"]
		}
		event := Object{"monitorName": copy["testName"], "monitorTarget": "https://example.com", "monitorType": "http", "status": 0, "prevStatus": 1, "message": copy["testBody"], "at": time.Now().Unix()}
		result := a.sendNotification(r.Context(), channel, event)
		respond(w, 200, result)
		return nil
	})
	a.route("GET /api/notifications/deliveries", false, func(w http.ResponseWriter, r *http.Request) error {
		rows, e := a.store.list(r.Context(), "delivery")
		if e != nil {
			return e
		}
		sort.Slice(rows, func(i, j int) bool { return integer(rows[i], "created_at") > integer(rows[j], "created_at") })
		if limit := queryLimit(r, 20, 100); len(rows) > limit {
			rows = rows[:limit]
		}
		respond(w, 200, Object{"deliveries": rows})
		return nil
	})
	a.route("GET /api/notifications/stats", false, a.notificationStats)
}

// 渠道与待投递记录在同一事务删除，避免留下孤立重试。
// Remove channels and pending deliveries in one transaction to avoid orphaned retries.
func deleteNotification(t *transaction, id string) error {
	if e := t.remove("notification", id); e != nil {
		return e
	}
	for _, kind := range []string{"delivery", "outbox"} {
		records, e := t.list(kind)
		if e != nil {
			return e
		}
		for _, record := range records {
			if str(record, "channel_id") != id {
				continue
			}
			if e = t.remove(kind, str(record, "id")); e != nil {
				return e
			}
		}
	}
	return nil
}

func writeNotification(t *transaction, id string, row, input Object) error {
	if row == nil {
		row = Object{"id": id, "name": "", "type": "", "config": Object{}, "group_ids": []string{}, "active": 1, "created_at": time.Now().Unix()}
	}
	for _, key := range []string{"name", "type", "config", "group_ids", "active"} {
		if v, exists := input[key]; exists {
			row[key] = v
		}
	}
	if strings.TrimSpace(str(row, "name")) == "" || len(str(row, "name")) > 120 {
		return failure("name_required", 400)
	}
	if !contains(notificationTypes, str(row, "type")) {
		return failure("unsupported_type", 400)
	}
	config := object(row["config"])
	if config == nil {
		return failure("invalid_config", 400)
	}
	if _, exists := config["language"]; exists && notificationCopy[str(config, "language")] == nil {
		return failure("notification_language_invalid", 400)
	}
	clean := Object{}
	for k, v := range config {
		if s, ok := v.(string); ok {
			clean[k] = s
		}
	}
	if code := notificationConfigError(str(row, "type"), clean); code != "" {
		return failure(code, 400)
	}
	row["config"] = clean
	if e := validateNotificationGroups(t, stringsOf(row["group_ids"])); e != nil {
		return e
	}
	row["updated_at"] = time.Now().Unix()
	return t.put("notification", id, row)
}

func validateNotificationGroups(t *transaction, ids []string) error {
	for _, id := range ids {
		group, e := t.get("group", id)
		if e != nil {
			return e
		}
		if group == nil {
			return failure("group_not_found", 400)
		}
	}
	return nil
}

func (a *App) notificationWrite(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	created := id == ""
	if created {
		id = uuid()
	}
	var input Object
	var e error
	if r.Method != "DELETE" {
		input, e = body(r)
		if e != nil {
			return e
		}
	}
	e = a.store.mutate(r.Context(), func(t *transaction) error {
		row, e := t.get("notification", id)
		if e != nil {
			return e
		}
		if !created && row == nil {
			return failure("not_found", 404)
		}
		if r.Method == "DELETE" {
			return deleteNotification(t, id)
		}
		return writeNotification(t, id, row, input)
	})
	if e != nil {
		return e
	}
	if created {
		respond(w, 201, Object{"id": id})
	} else {
		respond(w, 200, Object{"ok": true})
	}
	return nil
}

func formatCopy(template string, values map[string]string) string {
	pairs := make([]string, 0, len(values)*2)
	for key, value := range values {
		pairs = append(pairs, "{"+key+"}", value)
	}
	return strings.NewReplacer(pairs...).Replace(template)
}
func notificationMessage(event, config Object) (string, string) {
	copy := notificationCopy[str(config, "language")]
	if copy == nil {
		copy = notificationCopy["en-US"]
	}
	states := []string{str(copy, "down"), str(copy, "up"), str(copy, "warn")}
	status := int(integer(event, "status"))
	if status < 0 || status > 2 {
		status = 2
	}
	template := str(copy, "headline")
	transition := formatCopy(str(copy, "firstState"), map[string]string{"state": states[status]})
	if event["prevStatus"] == nil {
		template = str(copy, "firstHeadline")
	} else {
		previous := int(integer(event, "prevStatus"))
		if previous < 0 || previous > 2 {
			previous = 2
		}
		transition = states[previous] + " -> " + states[status]
		if status == 1 && previous == 0 {
			template = str(copy, "recovered")
		}
	}
	title := formatCopy(template, map[string]string{"name": str(event, "monitorName"), "state": states[status]})
	actionKey := "actionWarn"
	if status == 0 {
		actionKey = "actionDown"
	} else if status == 1 {
		actionKey = "actionUpCurrent"
		if event["prevStatus"] != nil && (integer(event, "prevStatus") == 0 || integer(event, "prevStatus") == 2) {
			actionKey = "actionUp"
		}
	}
	lines := []string{title, formatCopy(str(copy, "target"), map[string]string{"value": str(event, "monitorTarget")}), formatCopy(str(copy, "type"), map[string]string{"value": str(event, "monitorType")}), formatCopy(str(copy, "state"), map[string]string{"value": transition})}
	if str(event, "message") != "" {
		lines = append(lines, formatCopy(str(copy, "detail"), map[string]string{"value": str(event, "message")}))
	}
	if code := integer(event, "statusCode"); code > 0 {
		lines = append(lines, formatCopy(str(copy, "response"), map[string]string{"value": fmt.Sprint(code)}))
	}
	if value := event["latencyMs"]; value != nil {
		latency := number(value)
		if latency >= 0 && !math.IsNaN(latency) && !math.IsInf(latency, 0) {
			lines = append(lines, formatCopy(str(copy, "latency"), map[string]string{"value": fmt.Sprintf("%.0f ms", math.Round(latency))}))
		}
	}
	lines = append(lines, formatCopy(str(copy, "action"), map[string]string{"value": str(copy, actionKey)}))
	lines = append(lines, formatCopy(str(copy, "time"), map[string]string{"value": time.Unix(integer(event, "at"), 0).UTC().Format("2006-01-02 15:04:05 UTC")}))
	return title, strings.Join(lines, "\n")
}
func scrubNotificationText(message string, config Object, monitorTarget bool) string {
	secrets := map[string]struct{}{}
	redact := func(value string) {
		if value == "" {
			return
		}
		for _, variant := range []string{value, url.QueryEscape(value), url.PathEscape(value)} {
			secrets[variant] = struct{}{}
		}
	}
	for key, v := range config {
		value, ok := v.(string)
		if !ok || !contains([]string{"bot_token", "secret", "sendkey", "key", "url", "webhook_url", "urls"}, key) {
			continue
		}
		value = strings.TrimSpace(value)
		redact(value)
		if key != "url" && key != "webhook_url" && key != "urls" {
			continue
		}
		for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' }) {
			redact(part)
			address := part
			if !targetSchemePattern.MatchString(address) {
				address = "http://" + address
			}
			if u, err := url.Parse(address); err == nil {
				if u.User != nil {
					redact(u.User.Username())
					password, _ := u.User.Password()
					redact(password)
				}
				if !monitorTarget {
					for _, segment := range strings.Split(u.Path, "/") {
						if len(segment) >= 4 {
							redact(segment)
						}
					}
				}
				for _, values := range u.Query() {
					for _, secret := range values {
						redact(secret)
					}
				}
				redact(u.Fragment)
				if fragment, err := url.ParseQuery(u.Fragment); err == nil {
					for _, values := range fragment {
						for _, secret := range values {
							redact(secret)
						}
					}
				}
			}
		}
	}
	values := make([]string, 0, len(secrets))
	for secret := range secrets {
		values = append(values, secret)
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	patterns := []string{
		`(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>]+`,
		`\b\d{6,}:[A-Za-z0-9_-]{20,}\b`,
		`(?i)\bBearer\s+[^\s"']+`,
		`(?i)\b(bot_token|access_token|api_key|token|key|secret|password|sendkey)["']?\s*[:=]\s*["']?[^\s&,"'}]+`,
	}
	for _, value := range values {
		pattern := regexp.QuoteMeta(value)
		if len(value) <= 3 && regexp.MustCompile(`^\w+$`).MatchString(value) {
			pattern = `\b` + pattern + `\b`
		}
		patterns = append(patterns, pattern)
	}
	credentialField := regexp.MustCompile(`(?i)^(bot_token|access_token|api_key|token|key|secret|password|sendkey)["']?\s*[:=]`)
	return regexp.MustCompile(strings.Join(patterns, "|")).ReplaceAllStringFunc(message, func(match string) string {
		if field := credentialField.FindStringSubmatch(match); field != nil {
			return field[1] + "=[redacted]"
		}
		if strings.HasPrefix(strings.ToLower(match), "bearer ") {
			return "Bearer [redacted]"
		}
		return "[redacted]"
	})
}

func scrubProviderError(message string, config Object) string {
	message = scrubNotificationText(message, config, false)
	runes := []rune(message)
	if len(runes) > 400 {
		message = string(runes[:400])
	}
	return message
}

// 通知正文清理监控目标中的凭据；提供商错误在写入投递记录前脱敏。
// Scrub monitored-target credentials from messages and provider errors from delivery records.
func (a *App) sendNotification(ctx context.Context, channel, event Object) Object {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	config := object(channel["config"])
	kind := str(channel, "type")
	event = clone(event)
	targetValue := str(event, "monitorTarget")
	event["monitorTarget"] = publicTarget(targetValue)
	event["message"] = scrubNotificationText(str(event, "message"), Object{"url": targetValue}, true)
	title, message := notificationMessage(event, config)
	target := ""
	payload := Object{}
	contentType := "application/json"
	var raw []byte
	switch kind {
	case "telegram":
		target = "https://api.telegram.org/bot" + str(config, "bot_token") + "/sendMessage"
		payload = Object{"chat_id": config["chat_id"], "text": html.EscapeString(message), "parse_mode": "HTML", "disable_web_page_preview": true}
	case "feishu":
		target = str(config, "webhook_url")
		payload = Object{"msg_type": "text", "content": Object{"text": message}}
	case "slack":
		target = str(config, "webhook_url")
		payload = Object{"text": message, "unfurl_links": false, "unfurl_media": false}
	case "discord":
		target = str(config, "webhook_url")
		runes := []rune(message)
		if len(runes) > 2000 {
			message = string(runes[:2000])
		}
		payload = Object{"content": message}
	case "apprise":
		target = strings.TrimRight(str(config, "url"), "/")
		severity := "info"
		switch integer(event, "status") {
		case 0:
			severity = "failure"
		case 2:
			severity = "warning"
		case 1:
			if event["prevStatus"] != nil && integer(event, "prevStatus") == 0 {
				severity = "success"
			}
		}
		payload = Object{"title": title, "body": message, "type": severity}
		if key := str(config, "key"); key != "" {
			target += "/" + url.PathEscape(key)
		} else {
			payload["urls"] = config["urls"]
		}
	case "serverchan":
		key := str(config, "sendkey")
		match := regexp.MustCompile(`^sctp(\d+)t[A-Za-z0-9_-]+$`).FindStringSubmatch(key)
		if match != nil {
			target = "https://" + match[1] + ".push.ft07.com/send/" + url.PathEscape(key) + ".send"
		}
		contentType = "application/x-www-form-urlencoded"
		raw = []byte(url.Values{"title": {title}, "desp": {message}}.Encode())
	case "webhook":
		target = str(config, "url")
		state := map[int64]string{0: "down", 1: "up", 2: "warn"}[integer(event, "status")]
		transition := strings.ToUpper(state) + " (first reading)"
		if event["prevStatus"] != nil {
			transition = map[int64]string{0: "DOWN", 1: "UP", 2: "WARN"}[integer(event, "prevStatus")] + " -> " + strings.ToUpper(state)
		}
		payload = Object{"event": state, "monitor": Object{"name": event["monitorName"], "target": event["monitorTarget"], "type": event["monitorType"]}, "status": event["status"], "prevStatus": event["prevStatus"], "transition": transition, "recovered": integer(event, "status") == 1 && event["prevStatus"] != nil && integer(event, "prevStatus") == 0, "message": event["message"], "time": iso(integer(event, "at")), "text": message}
	}
	if raw == nil {
		raw = []byte(encode(payload))
	}
	result := Object{"ok": false}
	req, e := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(raw))
	if e == nil {
		req.Header.Set("Content-Type", contentType)
		if kind == "webhook" && str(config, "secret") != "" {
			req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(str(config, "secret")))
		}
		client := &http.Client{CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.Do(req)
		e = err
		if e == nil {
			body, readErr := io.ReadAll(io.LimitReader(response.Body, 65536))
			_ = response.Body.Close()
			if readErr != nil {
				e = readErr
			} else if response.StatusCode < 200 || response.StatusCode >= 300 {
				reason := strings.TrimSpace(string(body))
				if reason != "" {
					e = fmt.Errorf("http_%d: %s", response.StatusCode, reason)
				} else {
					e = fmt.Errorf("http_%d", response.StatusCode)
				}
			} else {
				var data Object
				_ = json.Unmarshal(body, &data)
				switch kind {
				case "telegram":
					if data["ok"] != true {
						e = fmt.Errorf("telegram_not_ok: %s", str(data, "description"))
					}
				case "feishu", "serverchan":
					code, ok := data["code"].(float64)
					if !ok || code != 0 {
						e = fmt.Errorf("%s_not_ok: %s", kind, str(data, "msg")+str(data, "message"))
					}
				}
			}
		}
	}
	if e == nil {
		result["ok"] = true
	} else {
		result["error"] = scrubProviderError(e.Error(), config)
	}
	id := uuid()
	delivery := Object{"id": id, "channel_id": channel["id"], "monitor_id": event["monitorId"], "monitor_name": event["monitorName"], "status": event["status"], "ok": result["ok"], "latency_ms": elapsed(start), "error": result["error"], "created_at": time.Now().Unix()}
	_ = a.store.put(context.Background(), "delivery", id, delivery)
	return result
}

func (a *App) queueNotifications(t *transaction, m, live Object) (bool, error) {
	channels, e := t.list("notification")
	if e != nil {
		return false, e
	}
	queued := false
	for _, channel := range channels {
		scope := stringsOf(channel["group_ids"])
		if !boolean(channel["active"]) || len(scope) > 0 && !contains(scope, str(m, "group_id")) {
			continue
		}
		id := uuid()
		event := Object{"monitorId": m["id"], "monitorName": m["name"], "monitorTarget": m["target"], "monitorType": m["type"], "status": live["st"], "prevStatus": live["prev_st"], "message": live["msg"], "statusCode": live["code"], "latencyMs": live["v"], "at": live["ts"]}
		sequence, e := t.next("outbox")
		if e != nil {
			return false, e
		}
		now := time.Now().Unix()
		row := Object{"id": id, "channel_id": channel["id"], "event": event, "sequence": sequence, "created_at": now, "attempts": 0, "next_at": now, "state": "pending"}
		if e = t.put("outbox", id, row); e != nil {
			return false, e
		}
		queued = true
	}
	return queued, nil
}

// 每个渠道与监控组合只处理队首，失败重试不得越过更早事件。
// Process only the head of each channel/monitor queue, preserving event order across retries.
func (a *App) deliverPending() {
	rows, e := a.store.list(a.ctx, "outbox")
	if e != nil {
		return
	}
	heads := map[string]Object{}
	for _, row := range rows {
		if str(row, "state") != "pending" {
			continue
		}
		key := encode([]string{str(row, "channel_id"), str(object(row["event"]), "monitorId")})
		head := heads[key]
		if head == nil || integer(row, "sequence") < integer(head, "sequence") {
			heads[key] = row
		}
	}
	for key, row := range heads {
		if integer(row, "next_at") > time.Now().Unix() && integer(row, "created_at")+7*86400 > time.Now().Unix() {
			continue
		}
		select {
		case a.semaphore <- struct{}{}:
		default:
			return
		}
		a.wg.Add(1)
		store := a.store
		go func(key string, row Object) {
			a.storeLock.RLock()
			defer a.storeLock.RUnlock()
			defer a.wg.Done()
			defer func() { <-a.semaphore }()
			if a.store != store {
				return
			}
			owner := token(12)
			lease := "delivery-group:" + key
			claimed, e := a.store.claim(a.ctx, lease, owner, time.Now().Unix(), 30, true)
			if e != nil || !claimed {
				return
			}
			defer a.store.release(context.Background(), lease, owner, 0)
			latest, e := a.store.get(a.ctx, "outbox", str(row, "id"))
			if e != nil || latest == nil || str(latest, "state") != "pending" {
				return
			}
			// Recheck the queue after acquiring the group lease.
			pending, e := a.store.list(a.ctx, "outbox")
			if e != nil {
				return
			}
			for _, other := range pending {
				if str(other, "state") == "pending" && str(other, "channel_id") == str(latest, "channel_id") && str(object(other["event"]), "monitorId") == str(object(latest["event"]), "monitorId") && integer(other, "sequence") < integer(latest, "sequence") {
					return
				}
			}
			now := time.Now().Unix()
			if integer(latest, "created_at")+7*86400 <= now {
				latest["state"] = "failed"
			} else if integer(latest, "next_at") > now {
				return
			} else {
				channel, err := a.store.get(a.ctx, "notification", str(row, "channel_id"))
				if err != nil {
					return
				}
				settings, err := a.settings(a.ctx)
				if err != nil {
					return
				}
				if channel == nil || !boolean(channel["active"]) {
					latest["state"] = "cancelled"
				} else if boolean(maintenance(settings)["active"]) {
					latest["next_at"] = now + 30
				} else {
					result := a.sendNotification(a.ctx, channel, object(latest["event"]))
					attempts := integer(latest, "attempts") + 1
					latest["attempts"] = attempts
					if boolean(result["ok"]) {
						latest["state"] = "delivered"
					} else if attempts >= 8 {
						latest["state"] = "failed"
					} else {
						latest["next_at"] = time.Now().Unix() + attempts*30
					}
				}
			}
			_ = a.store.put(a.ctx, "outbox", str(latest, "id"), latest)
		}(key, row)
	}
}

func (a *App) notificationStats(w http.ResponseWriter, r *http.Request) error {
	rows, e := a.store.list(r.Context(), "delivery")
	if e != nil {
		return e
	}
	now := time.Now().Unix()
	channels := Object{}
	sums := map[string]float64{}
	for _, row := range rows {
		if integer(row, "created_at") < now-86400 {
			continue
		}
		id := str(row, "channel_id")
		stats := object(channels[id])
		if stats == nil {
			stats = Object{"sent24h": 0, "failed24h": 0, "avgLatencyMs": 0, "lastSentAt": nil, "lastOk": nil, "hourly": make([]int, 24)}
			channels[id] = stats
		}
		stats["sent24h"] = integer(stats, "sent24h") + 1
		if !boolean(row["ok"]) {
			stats["failed24h"] = integer(stats, "failed24h") + 1
		}
		sums[id] += number(row["latency_ms"])
		stats["avgLatencyMs"] = sums[id] / number(stats["sent24h"])
		if integer(row, "created_at") >= integer(stats, "lastSentAt") {
			stats["lastSentAt"] = row["created_at"]
			stats["lastOk"] = row["ok"]
		}
		hourly := stats["hourly"].([]int)
		index := 23 - int((now/3600)-(integer(row, "created_at")/3600))
		if index >= 0 && index < 24 {
			hourly[index]++
		}
	}
	respond(w, 200, Object{"channels": channels, "now": now})
	return nil
}
