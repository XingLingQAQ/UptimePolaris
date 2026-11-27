package polaris

import (
	"math"
	"strings"
	"unicode/utf8"
)

func hardwareName(value any) bool {
	name, ok := value.(string)
	// Match JavaScript String.trim whitespace.
	const whitespace = " \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
	if !ok || len(name) > 512 || strings.Trim(name, whitespace) == "" || utf8.RuneCountInString(name) > 128 {
		return false
	}
	return !strings.ContainsFunc(name, func(r rune) bool { return r < 32 || r == 127 })
}

func hardwareNumber(value any, low, high float64, integerOnly bool) bool {
	if !validNumber(value) {
		return false
	}
	n := number(value)
	return n >= low && n <= high && (!integerOnly || n == math.Trunc(n))
}

func normalizedGPUs(value any) (any, bool) {
	if value == nil {
		return nil, true
	}
	rows, ok := value.([]any)
	if !ok || len(rows) > 16 {
		return nil, false
	}
	out := make([]Object, 0, len(rows))
	indices := map[float64]bool{}
	for _, item := range rows {
		row := object(item)
		if !hardwareNumber(row["index"], 0, 65535, true) || !hardwareName(row["name"]) || indices[number(row["index"])] {
			return nil, false
		}
		indices[number(row["index"])] = true
		gpu := Object{"index": row["index"], "name": row["name"]}
		if vendor, exists := row["vendor"]; exists {
			if !hardwareName(vendor) {
				return nil, false
			}
			gpu["vendor"] = vendor
		}
		for _, key := range []string{"util_pct", "mem_used_bytes", "mem_total_bytes", "temp_c", "power_w"} {
			metric, exists := row[key]
			if !exists {
				continue
			}
			low, high, integerOnly := 0.0, 100.0, false
			switch key {
			case "mem_used_bytes", "mem_total_bytes":
				high, integerOnly = 9007199254740991, true
			case "temp_c":
				low, high = -100, 250
			case "power_w":
				high = 10000
			}
			if metric != nil && !hardwareNumber(metric, low, high, integerOnly) {
				return nil, false
			}
			gpu[key] = metric
		}
		if gpu["mem_used_bytes"] != nil && gpu["mem_total_bytes"] != nil && number(gpu["mem_used_bytes"]) > number(gpu["mem_total_bytes"]) {
			return nil, false
		}
		out = append(out, gpu)
	}
	return out, true
}

func normalizedSensors(value any) (any, bool) {
	if value == nil {
		return nil, true
	}
	rows, ok := value.([]any)
	if !ok || len(rows) > 64 {
		return nil, false
	}
	out := make([]Object, 0, len(rows))
	for _, item := range rows {
		row := object(item)
		if !hardwareName(row["name"]) || !hardwareNumber(row["temp_c"], -100, 250, false) {
			return nil, false
		}
		sensor := Object{"name": row["name"], "temp_c": row["temp_c"]}
		if kind, exists := row["kind"]; exists {
			text, ok := kind.(string)
			if !ok || !contains([]string{"cpu", "disk", "gpu", "other"}, text) {
				return nil, false
			}
			sensor["kind"] = text
		}
		out = append(out, sensor)
	}
	return out, true
}
