package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"unicode"
)

// 只解析键值，不执行 shell 展开；返回值的优先级由调用方决定。
// Parse key-value pairs without shell expansion; callers determine their precedence.
func loadEnvFile(path string) (map[string]string, error) {
	values := make(map[string]string)
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return values, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read file")
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	line := 0
	for scanner.Scan() {
		line++
		text := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		if strings.HasPrefix(text, "export ") {
			text = strings.TrimSpace(text[7:])
		}
		key, raw, ok := strings.Cut(text, "=")
		key = strings.TrimSpace(key)
		if !ok || !validEnvKey(key) {
			return nil, fmt.Errorf("invalid syntax on line %d", line)
		}
		value, ok := parseEnvValue(strings.TrimSpace(raw))
		if !ok {
			return nil, fmt.Errorf("invalid syntax on line %d", line)
		}
		values[key] = value
	}
	if scanner.Err() != nil {
		return nil, fmt.Errorf("cannot read file")
	}
	return values, nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if !(r == '_' || unicode.IsLetter(r) || i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

func parseEnvValue(raw string) (string, bool) {
	if raw == "" {
		return "", true
	}
	if raw[0] == '\'' {
		end := strings.IndexByte(raw[1:], '\'')
		if end < 0 {
			return "", false
		}
		end++
		return raw[1:end], validEnvSuffix(raw[end+1:])
	}
	if raw[0] == '"' {
		escaped := false
		for i := 1; i < len(raw); i++ {
			if raw[i] == '"' && !escaped {
				value, err := strconv.Unquote(raw[:i+1])
				return value, err == nil && validEnvSuffix(raw[i+1:])
			}
			if raw[i] == '\\' && !escaped {
				escaped = true
			} else {
				escaped = false
			}
		}
		return "", false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] == '#' && (i == 0 || raw[i-1] == ' ' || raw[i-1] == '\t') {
			return strings.TrimSpace(raw[:i]), true
		}
		if raw[i] == '\'' || raw[i] == '"' {
			return "", false
		}
	}
	return strings.TrimSpace(raw), true
}

func validEnvSuffix(s string) bool {
	s = strings.TrimSpace(s)
	return s == "" || strings.HasPrefix(s, "#")
}
