package polaris

import (
	"strings"
	"unicode/utf8"
)

func containerText(value any, limit int) bool {
	text, ok := value.(string)
	const whitespace = " \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
	return ok && len(text) <= limit*4 && utf8.RuneCountInString(text) <= limit && strings.Trim(text, whitespace) != "" &&
		!strings.ContainsFunc(text, func(r rune) bool { return r < 32 || r >= 127 && r <= 159 })
}

func normalizedContainers(value any) (any, bool) {
	if value == nil {
		return nil, true
	}
	rows, ok := value.([]any)
	if !ok || len(rows) > 256 {
		return nil, false
	}
	out := make([]Object, 0, len(rows))
	ids := map[string]bool{}
	for _, item := range rows {
		row := object(item)
		if !containerText(row["id"], 64) || !containerText(row["name"], 128) {
			return nil, false
		}
		id := row["id"].(string)
		runtime, runtimeOK := row["runtime"].(string)
		state, stateOK := row["state"].(string)
		if ids[id] || !runtimeOK || !contains([]string{"docker", "podman"}, runtime) || !stateOK ||
			!contains([]string{"running", "exited", "restarting", "paused", "dead", "created", "unknown"}, state) {
			return nil, false
		}
		ids[id] = true
		container := Object{"id": id, "name": row["name"], "runtime": runtime, "state": state}
		if image, exists := row["image"]; exists {
			if !containerText(image, 256) {
				return nil, false
			}
			container["image"] = image
		}
		if health, exists := row["health"]; exists {
			text, ok := health.(string)
			if !ok || !contains([]string{"healthy", "unhealthy", "starting", "none"}, text) {
				return nil, false
			}
			container["health"] = text
		}
		for key, max := range map[string]float64{"cpu_pct": 100000, "mem_used_bytes": 9007199254740991, "mem_limit_bytes": 9007199254740991, "restart_count": 1000000, "uptime_sec": 3153600000} {
			metric, exists := row[key]
			if !exists {
				continue
			}
			if metric != nil && !hardwareNumber(metric, 0, max, key != "cpu_pct") {
				return nil, false
			}
			container[key] = metric
		}
		out = append(out, container)
	}
	return out, true
}
