// 验证公开探针状态隐藏 Agent 身份，管理接口保留来源信息。
// Check that public probe status hides Agent identity while admin responses retain it.

package polaris

import (
	"strconv"
	"strings"
	"testing"
)

func TestPublicProbeSourceHidesAgentIdentity(t *testing.T) {
	s := newTestServer(t)
	code, agent := s.request(t, "POST", "/api/admin/agents", Object{"name": "private-probe-name", "probe_enabled": true}, true)
	expectStatus(t, code, 201, agent)
	id := str(agent, "id")
	code, report := s.request(t, "POST", "/api/public/agent/push/"+str(agent, "token"), Object{"jsonrpc": "2.0", "id": 1, "method": "basicReport", "params": Object{"kernel": "fixture-kernel", "mem_total": 1024, "version": "0.1.0", "transport": "ws", "report_interval_secs": 60, "name": "private-probe-name", "os": "linux", "arch": "x86_64", "cpu_model": "fixture", "cpu_cores": 1, "capabilities": []string{"probe_http"}}}, false)
	expectStatus(t, code, 200, report)
	monitor := s.createMonitor(t, "http", "https://example.com", Object{"check_source": Object{"type": "agent", "agent_id": id}})
	code, admin := s.request(t, "GET", "/api/overview", nil, true)
	expectStatus(t, code, 200, admin)
	var num int64
	for _, value := range array(admin["monitors"]) {
		row := object(value)
		if str(row, "id") == monitor {
			num = integer(row, "num_id")
			if str(row, "source_id") != id || str(row, "source_name") != "private-probe-name" {
				t.Fatal("admin source identity missing", row)
			}
		}
	}
	if num == 0 {
		t.Fatal("monitor missing from admin overview")
	}
	for _, path := range []string{"/api/public/status", "/api/public/monitors", "/api/public/monitors/" + strconv.FormatInt(num, 10)} {
		code, result := s.request(t, "GET", path, nil, false)
		expectStatus(t, code, 200, result)
		for _, private := range []string{id, "private-probe-name", "source_id", "source_name", "sourceId", "sourceName"} {
			if strings.Contains(encode(result), private) {
				t.Fatalf("%s exposes private source field %q", path, private)
			}
		}
	}
}
