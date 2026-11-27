package polaris

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type hardwareCase struct {
	Name     string `json:"name"`
	Input    Object `json:"input"`
	Expected Object `json:"expected"`
	Invalid  bool   `json:"invalid"`
}

func hardwareCases(t *testing.T) []hardwareCase {
	t.Helper()
	data, err := os.ReadFile("../../../../test/fixtures/agent-hardware.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []hardwareCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestAgentHardwareContract(t *testing.T) {
	for _, item := range hardwareCases(t) {
		t.Run(item.Name, func(t *testing.T) {
			gpus, gpuOK := normalizedGPUs(item.Input["gpus"])
			sensors, sensorOK := normalizedSensors(item.Input["sensors"])
			if item.Invalid {
				if gpuOK && sensorOK {
					t.Fatal("invalid hardware accepted")
				}
				return
			}
			if !gpuOK || !sensorOK {
				t.Fatal("valid hardware rejected")
			}
			for key, value := range map[string]any{"gpus": gpus, "sensors": sensors} {
				if encode(value) != encode(item.Expected[key]) {
					t.Fatalf("%s: %v != %v", key, value, item.Expected[key])
				}
			}
		})
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, ok := normalizedGPUs([]any{Object{"index": float64(0), "name": "GPU", "util_pct": value}}); ok {
			t.Fatal("nonfinite GPU metric accepted")
		}
		if _, ok := normalizedSensors([]any{Object{"name": "CPU", "temp_c": value}}); ok {
			t.Fatal("nonfinite temperature accepted")
		}
	}
}

func TestAgentHardwareTelemetry(t *testing.T) { testAgentHardwareTelemetry(t, newTestServer(t)) }

func testAgentHardwareTelemetry(t *testing.T, s *testServer) {
	t.Helper()
	client := *s.client
	client.Jar = nil
	fixture := *s
	fixture.client = &client
	s = &fixture
	ctx := context.Background()
	now := time.Now().Unix()
	code, state := s.request(t, "GET", "/api/admin/presentation", nil, true)
	expectStatus(t, code, 200, state)
	config := object(state["config"])
	config["agentEnabled"] = true
	config["domains"] = []any{}
	code, result := s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
	expectStatus(t, code, 200, result)
	code, agent := s.request(t, "POST", "/api/admin/agents", Object{"name": "Hardware fixture", "is_public": true}, true)
	expectStatus(t, code, 201, agent)
	code, monitor := s.request(t, "POST", "/api/monitors", Object{"name": "Hardware", "type": "agent", "agent_id": agent["id"], "is_public": true}, true)
	expectStatus(t, code, 201, monitor)
	monitor, err := s.app.store.get(ctx, "monitor", str(monitor, "id"))
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/public/agent/push/" + str(agent, "token")
	push := func(extra Object, at int64, status int) {
		params := reportParams(at)
		for k, v := range extra {
			params[k] = v
		}
		code, out := s.request(t, "POST", path, Object{"method": "report", "params": params}, false)
		expectStatus(t, code, status, out)
	}
	detail := func() Object {
		code, out := s.request(t, "GET", "/api/admin/agents/"+str(agent, "id")+"/detail", nil, true)
		expectStatus(t, code, 200, out)
		return out
	}
	push(nil, now-5, 200)
	old := detail()
	for _, key := range []string{"gpus_json", "sensors_json"} {
		if _, exists := old[key]; exists {
			t.Fatal("old report emitted hardware", old)
		}
	}
	var valid hardwareCase
	for _, item := range hardwareCases(t) {
		if item.Name == "valid" {
			valid = item
		}
	}
	push(valid.Input, now-4, 200)
	stored := detail()
	live, err := s.app.store.get(ctx, "machine", str(agent, "id"))
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"gpus", "sensors"} {
		var parsed any
		if err := json.Unmarshal([]byte(str(stored, key+"_json")), &parsed); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(parsed, valid.Expected[key]) || stored[key+"_json"] != live[key+"_json"] {
			t.Fatal("hardware persistence mismatch", stored, live)
		}
	}
	code, result = s.request(t, "GET", "/api/admin/agents/"+str(agent, "id")+"/detail", nil, false)
	expectStatus(t, code, 401, result)
	for _, enabled := range []bool{false, true} {
		code, result = s.request(t, "PUT", "/api/admin/settings", Object{"site.showPublicAgentHardware": enabled}, true)
		expectStatus(t, code, 200, result)
		for _, route := range []string{"/api/public/agent/detail/" + fmt.Sprint(monitor["num_id"]), "/api/public/servers/" + str(agent, "id") + "?view=agent"} {
			code, result = s.request(t, "GET", route, nil, false)
			if code != 200 {
				t.Fatalf("%s: %d %v, monitor=%v", route, code, result, monitor)
			}
			expectStatus(t, code, 200, result)
			for _, secret := range []string{"gpus_json", "sensors_json", "Private GPU", "Private CPU package"} {
				if strings.Contains(encode(result), secret) {
					t.Fatal("public hardware leak", route, result)
				}
			}
		}
	}
	for _, item := range hardwareCases(t) {
		if item.Invalid {
			push(item.Input, now, 400)
		}
	}
	push(Object{"gpus": nil, "sensors": nil}, now-3, 200)
	push(nil, now-2, 200)
	push(Object{"gpus": []any{}, "sensors": []any{}}, now-10, 200)
	for _, key := range []string{"gpus_json", "sensors_json"} {
		if detail()[key] != stored[key] {
			t.Fatal("missing, null or stale report changed hardware")
		}
	}
	push(Object{"gpus": []any{}, "sensors": []any{}}, now-1, 200)
	cleared := detail()
	if cleared["gpus_json"] != "[]" || cleared["sensors_json"] != "[]" {
		t.Fatal("empty arrays did not clear hardware", cleared)
	}
}
