// 验证错误类型的 Agent 协议字段被拒绝。
// Check rejection of incorrectly typed Agent protocol fields.

package polaris

import (
	"context"
	"testing"
)

func TestAgentMalformedWireValues(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	if err := s.app.store.put(ctx, "agent", "a", Object{"id": "a", "token": "fixture-token", "active": true}); err != nil {
		t.Fatal(err)
	}
	cfg := Object{"sample_interval_secs": 5, "report_interval_secs": 60, "include_nics": []any{}, "exclude_nics": []any{}, "include_mounts": []any{}, "exclude_mounts": []any{}, "auto_update": false}
	inst := Object{"service_tier": nil, "config_path": "fixture", "executable_path": "fixture", "auto_update_supported": true}
	path := "/api/public/agent/config/fixture-token"
	code, out := s.request(t, "POST", path, Object{"config": cfg, "installation": inst, "revision": 42}, false)
	expectStatus(t, code, 400, out)
	invalid := clone(cfg)
	invalid["include_nics"] = []any{"x\x01"}
	code, out = s.request(t, "POST", path, Object{"config": invalid, "installation": inst, "revision": nil}, false)
	expectStatus(t, code, 400, out)
	basic := Object{"jsonrpc": "2.0", "id": 1, "method": "basicReport", "params": Object{"kernel": "fixture-kernel", "mem_total": 1024, "version": "0.1.0", "transport": "ws", "report_interval_secs": 60, "name": "h", "os": "x", "arch": "x", "cpu_model": "x", "cpu_cores": 1, "capabilities": []any{"commands", 123}}}
	code, out = s.request(t, "POST", "/api/public/agent/push/fixture-token", basic, false)
	expectStatus(t, code, 400, out)
	live, err := s.app.store.get(ctx, "machine", "a")
	if err != nil || live != nil {
		t.Fatal(live, err)
	}
	object(basic["params"])["capabilities"] = []any{"commands", "commands"}
	code, out = s.request(t, "POST", "/api/public/agent/push/fixture-token", basic, false)
	expectStatus(t, code, 200, out)
	live, err = s.app.store.get(ctx, "machine", "a")
	if err != nil || len(array(live["capabilities"])) != 1 {
		t.Fatal(live, err)
	}
	// 必填字段缺失时拒绝整帧，不补旧版本默认值。
	// Reject missing required fields without supplying old-version defaults.
	for _, key := range []string{"kernel", "mem_total", "version", "transport", "report_interval_secs", "capabilities"} {
		params := clone(object(basic["params"]))
		delete(params, key)
		frame := clone(basic)
		frame["params"] = params
		code, out = s.request(t, "POST", "/api/public/agent/push/fixture-token", frame, false)
		expectStatus(t, code, 400, out)
	}
	for _, key := range []string{"observed_at", "summaries", "interfaces", "mounts", "message"} {
		params := reportParams(1)
		delete(params, key)
		code, out = s.request(t, "POST", "/api/public/agent/push/fixture-token", Object{"method": "report", "params": params}, false)
		expectStatus(t, code, 400, out)
	}
}
