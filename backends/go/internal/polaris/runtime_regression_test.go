// 验证运行时历史、重试租约、取消与账号规则。
// Check runtime history, retry leases, cancellation, and account rules.

package polaris

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func TestReviewArchivedDayRemainsCompleteAfterRetention(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	today := now / 86400 * 86400
	day := today - 86400
	if now-today < 2 {
		t.Skip("needs non-boundary second")
	}
	if e := s.app.store.put(ctx, "config", "settings", Object{"retention.detailDays": 1}); e != nil {
		t.Fatal(e)
	}
	if e := s.app.store.put(ctx, "monitor", "archive-case", Object{"id": "archive-case", "active": true}); e != nil {
		t.Fatal(e)
	}
	for _, p := range []struct {
		ts int64
		st int
	}{{day + 1, 1}, {today - 1, 0}} {
		_, e := s.app.store.db.Exec(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES(?,?,?,1,200,'','{}')`, "archive-case", p.ts, p.st)
		if e != nil {
			t.Fatal(e)
		}
	}
	key := "archive-case:" + time.Unix(day, 0).UTC().Format("2006-01-02")
	if e := s.app.rollupHistory(ctx, true); e != nil {
		t.Fatal(e)
	}
	first, e := s.app.store.get(ctx, "day_stat", key)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.app.rollupHistory(ctx, true); e != nil {
		t.Fatal(e)
	}
	second, e := s.app.store.get(ctx, "day_stat", key)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("first archived day=%s; second archived day=%s", encode(first), encode(second))
	if integer(first, "t") != 2 || integer(first, "u") != 1 || integer(first, "t") != integer(second, "t") || integer(first, "u") != integer(second, "u") {
		t.Fatal("rolling detail cleanup overwrote complete archive with partial day")
	}
}
func TestReviewThirdCommandLeaseSurvivesAnotherPoll(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	code, agent := s.request(t, "POST", "/api/admin/agents", Object{"name": "retry fixture"}, true)
	expectStatus(t, code, 201, agent)
	if e := s.app.store.put(ctx, "config", "settings", Object{"security.allowAgentCommands": true}); e != nil {
		t.Fatal(e)
	}
	id := "third-attempt"
	if e := s.app.store.put(ctx, "command", id, Object{"id": id, "agent_id": agent["id"], "action": "re_report", "queued_at": now, "state": "pending", "attempts": 2}); e != nil {
		t.Fatal(e)
	}
	code, result := s.request(t, "GET", "/api/public/agent/jobs/"+str(agent, "token"), nil, false)
	expectStatus(t, code, 200, result)
	commands := array(result["commands"])
	if len(commands) != 1 {
		t.Fatal(result)
	}
	leased := object(commands[0])
	t.Logf("third lease=%s", encode(leased))
	code, result = s.request(t, "GET", "/api/public/agent/jobs/"+str(agent, "token"), nil, false)
	expectStatus(t, code, 200, result)
	row, e := s.app.store.get(ctx, "command", id)
	if e != nil {
		t.Fatal(e)
	}
	code, result = s.request(t, "POST", "/api/public/agent/commands/"+str(agent, "token")+"/result", Object{"id": id, "lease_token": leased["lease_token"], "ok": true, "message": "done"}, false)
	t.Logf("after another poll state=%s; result status=%d body=%s", str(row, "state"), code, encode(result))
	if code != 200 {
		t.Fatal("valid third lease invalidated before expiry")
	}
}

func TestReviewDailyAvailabilityCountsObservedMinutes(t *testing.T) {
	day := time.Now().Unix()/86400*86400 - 86400
	points := []reading{{ts: day, status: 0}}
	for i := int64(0); i < 12; i++ {
		points = append(points, reading{ts: day + 60 + i*5, status: 1})
	}
	days := dailyOf(points)
	t.Logf("one DOWN minute plus one UP minute: days=%s overall=%v", encode(days), overall(days))
	if number(overall(days)) != 50 {
		t.Fatal("daily availability is sample weighted instead of observed-minute weighted")
	}
}
func TestReviewUnreportedAgentHasNoSyntheticHistory(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	code, agent := s.request(t, "POST", "/api/admin/agents", Object{"name": "not installed"}, true)
	expectStatus(t, code, 201, agent)
	code, result := s.request(t, "POST", "/api/monitors", Object{"name": "waiting host", "type": "agent", "agent_id": agent["id"], "interval_sec": 60, "timeout_ms": 1000}, true)
	expectStatus(t, code, 201, result)
	id := str(result, "id")
	m, e := s.app.store.get(ctx, "monitor", id)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.app.passiveCheck(ctx, m); e != nil {
		t.Fatal(e)
	}
	points, e := s.app.readings(ctx, id, 0, 100)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("no machine report yet: synthetic history=%s", encode(ringOf(points, true, "agent")))
	if len(points) != 0 {
		t.Fatal("unreported agent generated availability and CPU observation")
	}
}

func TestRuntimeProbeCancellation(t *testing.T) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, e := l.Accept()
		if e == nil {
			accepted <- c
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- probeSocket(ctx, Object{"type": "tcp", "target": l.Addr().String()}, Object{"expect": "hello"})
	}()
	c := <-accepted
	defer c.Close()
	cancel()
	select {
	case <-done:
	case <-time.After(250 * time.Millisecond):
		c.Close()
		<-done
		t.Fatal("probeSocket remained blocked after context cancellation")
	}
}

func TestRuntimeOneAgentReportDoesNotMeetDuration(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	m := Object{"id": "m", "options_json": encode(Object{"alerts": Object{"cpu": Object{"enabled": true, "threshold": 80, "duration_sec": 30, "recovery_pct": 80}}})}
	machine := Object{"cpu_usage": 95, "reported_at": time.Now().Unix()}
	first := s.app.evaluateAgentAlerts(ctx, m, machine, CheckResult{Status: 1})
	state, e := s.app.store.get(ctx, "alert_state", "m")
	if e != nil {
		t.Fatal(e)
	}
	object(state["cpu"])["since"] = time.Now().Unix() - 30
	if e = s.app.store.put(ctx, "alert_state", "m", state); e != nil {
		t.Fatal(e)
	}
	second := s.app.evaluateAgentAlerts(ctx, m, machine, CheckResult{Status: 1})
	t.Logf("one report: initial status=%d, same report after 30s status=%d", first.Status, second.Status)
	if second.Status != 1 {
		t.Fatal("unchanged report incorrectly satisfies duration")
	}
}
func TestAgentHistoryRequiresNewReport(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	m := Object{"id": "agent-monitor", "active": true, "type": "agent", "agent_id": "a", "interval_sec": 60, "options_json": encode(Object{"alerts": Object{"cpu": Object{"enabled": true, "threshold": 80, "duration_sec": 30, "recovery_pct": 80}}})}

	for _, v := range []struct {
		kind, id string
		row      Object
	}{{"monitor", "agent-monitor", m}, {"agent", "a", Object{"id": "a", "active": true}}, {"machine", "a", Object{"reported_at": now - 31, "report_interval_secs": 60, "cpu_usage": 95}}} {
		if err := s.app.store.put(ctx, v.kind, v.id, v.row); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.app.passiveCheck(ctx, m); err != nil {
		t.Fatal(err)
	}
	if _, err := s.app.store.db.Exec(`DELETE FROM polaris_leases WHERE id=?`, "monitor:agent-monitor"); err != nil {
		t.Fatal(err)
	}
	if err := s.app.passiveCheck(ctx, m); err != nil {
		t.Fatal(err)
	}
	points, err := s.app.readings(ctx, "agent-monitor", 0, 100)
	if err != nil || len(points) != 1 || points[0].status != 1 {
		t.Fatal(points, err)
	}
	if err = s.app.store.put(ctx, "machine", "a", Object{"reported_at": now, "report_interval_secs": 60, "cpu_usage": 95}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.app.store.db.Exec(`DELETE FROM polaris_leases WHERE id=?`, "monitor:agent-monitor"); err != nil {
		t.Fatal(err)
	}
	if err = s.app.passiveCheck(ctx, m); err != nil {
		t.Fatal(err)
	}
	points, err = s.app.readings(ctx, "agent-monitor", 0, 100)
	if err != nil || len(points) != 2 || points[1].status != 2 {
		t.Fatal(points, err)
	}
}

func TestUsernameSharedRules(t *testing.T) {
	for _, name := range []string{"ab", ".a", "_a", "-a", strings.Repeat("a", 32)} {
		if !usernamePattern.MatchString(name) {
			t.Fatalf("rejected %q", name)
		}
	}
	for _, name := range []string{"a", strings.Repeat("a", 33), "a b", "äb"} {
		if usernamePattern.MatchString(name) {
			t.Fatalf("accepted %q", name)
		}
	}
}
func TestThirdProbeLeaseSurvivesAnotherPoll(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	code, agent := s.request(t, "POST", "/api/admin/agents", Object{"name": "probe retry"}, true)
	expectStatus(t, code, 201, agent)
	stored, err := s.app.store.get(ctx, "agent", str(agent, "id"))
	if err != nil {
		t.Fatal(err)
	}
	stored["probe_enabled"] = true
	if err = s.app.store.put(ctx, "agent", str(agent, "id"), stored); err != nil {
		t.Fatal(err)
	}
	m := Object{"id": "m", "name": "m", "active": true, "type": "tcp", "target": "127.0.0.1:80", "interval_sec": 60, "timeout_ms": 1000, "options_json": "{}"}
	if err = s.app.store.put(ctx, "monitor", "m", m); err != nil {
		t.Fatal(err)
	}
	job := clone(m)
	job["run_id"] = "j"
	job["monitor_id"] = "m"
	job["agent_id"] = agent["id"]
	job["probe_type"] = "tcp"
	job["scheduled_at"] = now
	job["source_version"] = sourceVersion(m)
	job["state"] = "pending"
	job["attempts"] = 2
	if err = s.app.store.put(ctx, "probe_job", "j", job); err != nil {
		t.Fatal(err)
	}
	path := "/api/public/agent/jobs/" + str(agent, "token")
	code, result := s.request(t, "GET", path, nil, false)
	expectStatus(t, code, 200, result)
	jobs := array(result["jobs"])
	if len(jobs) != 1 {
		t.Fatal(result)
	}
	lease := object(jobs[0])["lease_token"]
	code, result = s.request(t, "GET", path, nil, false)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "POST", "/api/public/agent/results/"+str(agent, "token"), Object{"run_id": "j", "lease_token": lease, "status": 1, "latency_ms": 1, "observed_at": now, "status_code": 0, "message": "", "addons": Object{}}, false)
	expectStatus(t, code, 200, result)
}
