// 验证提供商错误与凭据脱敏边界。
// Check provider-error and credential-redaction boundaries.

package polaris

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestNotificationOutboundRedaction(t *testing.T) {
	s := newTestServer(t)
	requests := make(chan Object, 1)
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var received Object
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		requests <- received
		w.WriteHeader(http.StatusNoContent)
	}))
	defer endpoint.Close()
	previousTransport := http.DefaultTransport
	http.DefaultTransport = endpoint.Client().Transport
	defer func() { http.DefaultTransport = previousTransport }()
	channel := Object{"id": "redaction", "type": "webhook", "config": Object{"url": endpoint.URL, "secret": "delivery-secret", "language": "en-US"}}
	for _, tc := range []struct{ target, expected, kind string }{
		{"https://probe-user:probe-password@health.example/check/path?token=probe-token#access_token=fragment-token", "https://health.example/check/path", "http"},
		{"probe-user:probe-password@db.example:5432/check?password=probe-token#access_token=fragment-token", "db.example:5432/check", "tcp"},
		{"db.example:5432", "db.example:5432", "tcp"},
		{"", "", "push"},
	} {
		t.Run(tc.expected, func(t *testing.T) {
			event := Object{"monitorName": "fixture", "monitorTarget": tc.target, "monitorType": tc.kind, "status": 0, "prevStatus": 1, "message": "HTTP 503 at " + tc.target, "at": time.Now().Unix()}
			original := encode(event)
			result := s.app.sendNotification(context.Background(), channel, event)
			if result["ok"] != true {
				t.Fatal(result)
			}
			received := <-requests
			if str(object(received["monitor"]), "target") != tc.expected || !strings.Contains(str(received, "text"), "Target: "+tc.expected) {
				t.Fatal("text and structured target disagree", received)
			}
			for _, secret := range []string{"probe-user", "probe-password", "probe-token", "fragment-token"} {
				if strings.Contains(encode(received), secret) {
					t.Fatalf("outbound payload leaked %q: %s", secret, encode(received))
				}
			}
			if !strings.Contains(str(received, "message"), "HTTP 503") || encode(event) != original {
				t.Fatal("redaction lost diagnostic or mutated source event", received, event)
			}
		})
	}
}

func TestNotificationProviderErrorBoundary(t *testing.T) {
	s := newTestServer(t)
	const secret = "boundary+secret/value"
	const pathKey = "private-webhook-key"
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "provider unavailable: "+r.URL.String()+" Bearer "+secret+" "+url.QueryEscape(secret)+" "+pathKey+" "+strings.Repeat("中文", 300))
	}))
	defer endpoint.Close()
	previousTransport := http.DefaultTransport
	http.DefaultTransport = endpoint.Client().Transport
	defer func() { http.DefaultTransport = previousTransport }()
	config := Object{"url": endpoint.URL + "/hooks/" + pathKey + "?token=query-secret", "secret": secret, "chat_id": "1", "language": "zh-CN"}
	code, created := s.request(t, "POST", "/api/notifications", Object{"name": "boundary fixture", "type": "webhook", "config": config, "group_ids": []string{}}, true)
	expectStatus(t, code, http.StatusCreated, created)
	code, result := s.request(t, "POST", "/api/notifications/"+str(created, "id")+"/test", nil, true)
	expectStatus(t, code, http.StatusOK, result)
	if result["ok"] != false || !strings.Contains(str(result, "error"), "http_503") || !strings.Contains(str(result, "error"), "provider unavailable") {
		t.Fatal("failure reason was lost", result)
	}
	code, history := s.request(t, "GET", "/api/notifications/deliveries", nil, true)
	expectStatus(t, code, http.StatusOK, history)
	deliveries, ok := history["deliveries"].([]any)
	if !ok || len(deliveries) != 1 || str(object(deliveries[0]), "error") != str(result, "error") {
		t.Fatal("test API and persisted delivery must share the sanitized error", result, history)
	}
	for _, value := range []string{encode(result), encode(history)} {
		for _, leaked := range []string{secret, url.QueryEscape(secret), pathKey, "query-secret", endpoint.URL} {
			if strings.Contains(value, leaked) {
				t.Fatalf("provider error leaked %q: %s", leaked, value)
			}
		}
		if !utf8.ValidString(value) {
			t.Fatal("error truncation produced invalid UTF-8")
		}
	}
	if !utf8.ValidString(str(result, "error")) || strings.Contains(str(result, "error"), "\ufffd") {
		t.Fatal("provider error was cut inside a UTF-8 character", result)
	}
}

func TestProviderErrorScrubbingPreservesDiagnostics(t *testing.T) {
	config := Object{"bot_token": "T", "chat_id": "1", "language": "zh-CN"}
	for _, message := range []string{"http_401", "http_503", "Bad Request: chat not found", "telegram_token_required"} {
		if got := scrubProviderError(message, config); got != message {
			t.Fatalf("non-secret diagnostic changed: %q -> %q", message, got)
		}
	}
	const otherToken = "123456789" + ":" + "TEST_TOKEN_NOT_A_REAL_SECRET_000"
	message := scrubProviderError("invalid token "+otherToken+" Bearer private-bearer", config)
	if strings.Contains(message, otherToken) || strings.Contains(message, "private-bearer") {
		t.Fatal("short configured secret interfered with generic credential matching", message)
	}
}
