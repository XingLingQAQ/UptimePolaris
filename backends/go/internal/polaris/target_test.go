// 验证监控目标在创建、更新和立即检查时统一规范化。
// Check consistent target normalization on create, update, and immediate checks.

package polaris

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMonitorTargetNormalization(t *testing.T) {
	fixtures := []struct {
		kind, input, target string
	}{
		{"http", " example.com ", "https://example.com"},
		{"http", "example.com/https://nested/path", "https://example.com/https://nested/path"},
		{"http", "HTTP://example.com/health", "HTTP://example.com/health"},
		{"http", "https://[::1]:443/health", "https://[::1]:443/health"},
		{"tcp", " TcP://example.com:443 ", "example.com:443"},
		{"udp", "UDP://[::1]:53", "[::1]:53"},
		{"tls", "tls://example.com:443", "example.com:443"},
		{"tcp", "[::1]:443", "[::1]:443"},
		{"icmp", " [::1] ", "::1"},
		{"dns", "[2001:db8::1]", "2001:db8::1"},
		{"websocket", " wss://example.com/socket ", "wss://example.com/socket"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.kind+"/"+fixture.input, func(t *testing.T) {
			target, err := normalizeMonitorTarget(fixture.kind, fixture.input)
			if err != nil || target != fixture.target {
				t.Fatalf("normalized target = %q, %v; want %q", target, err, fixture.target)
			}
		})
	}
	for _, kind := range []string{"http", "tcp", "udp", "tls"} {
		for _, scheme := range []string{"tcp", "udp", "tls", "https"} {
			if scheme == kind || kind == "http" && scheme == "https" {
				continue
			}
			t.Run(kind+"/reject_"+scheme, func(t *testing.T) {
				if _, err := normalizeMonitorTarget(kind, scheme+"://127.0.0.1:443"); err == nil {
					t.Fatal("accepted another monitor type's protocol prefix")
				}
			})
		}
	}
}

func TestMonitorTargetNormalizationCreateAndUpdate(t *testing.T) {
	s := newTestServer(t)
	fixtures := []struct {
		kind, create, created, update, updated string
	}{
		{"http", " example.com/health ", "https://example.com/health", "changed.example.com/health", "https://changed.example.com/health"},
		{"tcp", "tcp://example.com:443", "example.com:443", "TCP://changed.example.com:8443", "changed.example.com:8443"},
		{"udp", "udp://[::1]:53", "[::1]:53", "UDP://[::1]:5353", "[::1]:5353"},
		{"tls", "tls://example.com:443", "example.com:443", "TLS://changed.example.com:8443", "changed.example.com:8443"},
		{"icmp", "[::1]", "::1", "[2001:db8::1]", "2001:db8::1"},
		{"dns", "[::1]", "::1", "[2001:db8::1]", "2001:db8::1"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.kind, func(t *testing.T) {
			if fixture.kind == "icmp" && !s.app.icmpAvailable {
				t.Skip("native ICMP is unavailable; pure normalization remains covered")
			}
			opts := Object{}
			if fixture.kind == "dns" {
				opts["dns"] = Object{"recordType": "AAAA"}
			}
			id := s.createMonitor(t, fixture.kind, fixture.create, opts)
			stored, err := s.app.store.get(context.Background(), "monitor", id)
			if err != nil || str(stored, "target") != fixture.created {
				t.Fatal("create did not persist the canonical target", stored, err)
			}
			code, result := s.request(t, "PUT", "/api/monitors/"+id, Object{"target": fixture.update}, true)
			expectStatus(t, code, 200, result)
			stored, err = s.app.store.get(context.Background(), "monitor", id)
			if err != nil || str(stored, "target") != fixture.updated {
				t.Fatal("update did not persist the canonical target", stored, err)
			}
		})
	}
}

func TestMonitorTargetNormalizationImmediateChecks(t *testing.T) {
	s := newTestServer(t)
	tlsFixture := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer tlsFixture.Close()
	fixtures := []struct {
		kind, target string
		options      Object
		status       int64
	}{
		{"http", strings.TrimPrefix(tlsFixture.URL, "https://"), Object{}, 0},
		{"tcp", "TCP://" + tcpFixture(t), Object{"send": "PING", "expect": "echo:PING"}, 1},
		{"udp", "udp://" + udpFixture(t), Object{"send": "ping", "expect": "ping"}, 1},
		{"tls", "TLS://" + strings.TrimPrefix(tlsFixture.URL, "https://"), Object{}, 2},
		{"dns", "[::1]", Object{"dns": Object{"recordType": "AAAA", "expected": "::1"}}, 1},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.kind, func(t *testing.T) {
			code, result := s.request(t, "POST", "/api/monitors/check", Object{"name": "target contract", "type": fixture.kind, "target": fixture.target, "timeout_ms": 1000, "options_json": fixture.options}, true)
			expectStatus(t, code, 200, result)
			if integer(result, "status") != fixture.status {
				t.Fatal("normalized input did not reach the local probe", result)
			}
			if fixture.kind == "http" && !strings.Contains(str(result, "message"), "certificate") {
				t.Fatal("bare HTTP target did not default to the local HTTPS listener", result)
			}
		})
	}
	if s.app.icmpAvailable {
		code, result := s.request(t, "POST", "/api/monitors/check", Object{"name": "IPv6 loopback", "type": "icmp", "target": "[::1]", "timeout_ms": 150}, true)
		expectStatus(t, code, 200, result)
	}
}
