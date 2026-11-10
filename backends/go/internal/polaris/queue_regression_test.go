// 验证通知队列、历史汇总、清理与租约。
// Check notification queues, history aggregation, cleanup, and leases.

package polaris

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestNotificationQueueOrderRetryAndAge(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	var mu sync.Mutex
	calls := []string{}
	fail := true
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		calls = append(calls, body["event"].(string))
		shouldFail := fail
		mu.Unlock()
		if shouldFail {
			w.WriteHeader(503)
		} else {
			w.WriteHeader(200)
		}
	}))
	defer endpoint.Close()
	previousTransport := http.DefaultTransport
	http.DefaultTransport = endpoint.Client().Transport
	defer func() { http.DefaultTransport = previousTransport }()
	put := func(kind, id string, o Object) {
		t.Helper()
		if err := s.app.store.put(ctx, kind, id, o); err != nil {
			t.Fatal(err)
		}
	}
	code, created := s.request(t, "POST", "/api/notifications", Object{"name": "queue fixture", "type": "webhook", "config": Object{"url": endpoint.URL}, "group_ids": []string{}}, true)
	expectStatus(t, code, 201, created)
	channelID := str(created, "id")
	channel, err := s.app.store.get(ctx, "notification", channelID)
	if err != nil || str(object(channel["config"]), "url") != endpoint.URL {
		t.Fatal("saved HTTPS channel missing", channel, err)
	}
	err = s.app.store.mutate(ctx, func(tx *transaction) error {
		for _, status := range []int{0, 1} {
			_, err := s.app.queueNotifications(tx, Object{"id": "m", "name": "m", "type": "http"}, Object{"st": status, "ts": time.Now().Unix()})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 8; attempt++ {
		s.app.deliverPending()
		s.app.wg.Wait()
		rows, err := s.app.store.list(ctx, "outbox")
		if err != nil {
			t.Fatal(err)
		}
		var head Object
		for _, row := range rows {
			if integer(row, "sequence") == 1 {
				head = row
			}
		}
		if integer(head, "attempts") != int64(attempt) {
			t.Fatalf("attempt %d: %v", attempt, head)
		}
		if attempt < 8 {
			if str(head, "state") != "pending" {
				t.Fatal(head)
			}
			head["next_at"] = time.Now().Unix() - 1
			put("outbox", str(head, "id"), head)
		} else if str(head, "state") != "failed" {
			t.Fatal(head)
		}
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	s.app.deliverPending()
	s.app.wg.Wait()
	mu.Lock()
	got := append([]string(nil), calls...)
	mu.Unlock()
	if !reflect.DeepEqual(got, []string{"down", "down", "down", "down", "down", "down", "down", "down", "up"}) {
		t.Fatal(got)
	}
	old := time.Now().Unix() - 8*86400
	put("outbox", "old", Object{"id": "old", "channel_id": channelID, "event": Object{"monitorId": "old", "status": 0}, "state": "pending", "sequence": 100, "next_at": old, "created_at": old})
	s.app.deliverPending()
	s.app.wg.Wait()
	row, err := s.app.store.get(ctx, "outbox", "old")
	if err != nil || str(row, "state") != "failed" {
		t.Fatal(row, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 9 {
		t.Fatal(calls)
	}
}

func TestArchiveBeforeCleanupAndDeleteRemovesStats(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	today := time.Now().Unix() / 86400 * 86400
	day := today - 2*86400
	if err := s.app.store.put(ctx, "config", "settings", Object{"retention.detailDays": 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.app.store.put(ctx, "monitor", "m", Object{"id": "m", "active": true}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct {
		ts     int64
		status int
	}{{day + 1, 0}, {day + 20, 1}, {day + 60, 0}} {
		if _, err := s.app.store.db.Exec(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES(?,?,?,1,0,'','{}')`, "m", p.ts, p.status); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.app.rollupHistory(ctx, true); err != nil {
		t.Fatal(err)
	}
	key := "m:" + time.Unix(day, 0).UTC().Format("2006-01-02")
	stat, err := s.app.store.get(ctx, "day_stat", key)
	if err != nil || integer(stat, "t") != 2 || integer(stat, "u") != 1 {
		t.Fatal(stat, err)
	}
	var count int
	if err = s.app.store.db.QueryRow(`SELECT COUNT(*) FROM polaris_readings WHERE monitor_id='m'`).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	if err = s.app.rollupHistory(ctx, true); err != nil {
		t.Fatal(err)
	}
	again, err := s.app.store.get(ctx, "day_stat", key)
	if err != nil || integer(again, "t") != 2 {
		t.Fatal(again, err)
	}
	code, result := s.request(t, "DELETE", "/api/monitors/m", nil, true)
	expectStatus(t, code, 200, result)
	stat, err = s.app.store.get(ctx, "day_stat", key)
	if err != nil || stat != nil {
		t.Fatal(stat, err)
	}
}

func TestQueueQueryFiltersAgentAndActiveLease(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	for id, row := range map[string]Object{"pending": {"agent_id": "a", "state": "pending", "scheduled_at": now}, "held": {"agent_id": "a", "state": "leased", "lease_until": now + 60}, "other": {"agent_id": "b", "state": "pending"}, "done": {"agent_id": "a", "state": "completed"}} {
		if err := s.app.store.put(ctx, "probe_job", id, row); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := s.app.store.queueDocuments(ctx, s.app.store.db, "probe_job", "agent_id", "a", false, "", 128)
	if err != nil || len(rows) != 1 || str(rows[0], "state") != "pending" {
		t.Fatal(rows, err)
	}
}
func TestArchiveBatchedCleanupKeepsCompleteDay(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	day := time.Now().Unix()/86400*86400 - 2*86400
	if err := s.app.store.put(ctx, "config", "settings", Object{"retention.detailDays": 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.app.store.put(ctx, "monitor", "m", Object{"id": "m", "active": true}); err != nil {
		t.Fatal(err)
	}
	if err := s.app.store.mutate(ctx, func(tx *transaction) error {
		stmt, err := tx.tx.Prepare(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES('m',?,?,1,0,'','{}')`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for i := 0; i < 5001; i++ {
			status := 0
			if i == 5000 {
				status = 1
			}
			if _, err = stmt.Exec(day+int64(i%60), status); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	key := "m:" + time.Unix(day, 0).UTC().Format("2006-01-02")
	for pass := 0; pass < 2; pass++ {
		if err := s.app.rollupHistory(ctx, true); err != nil {
			t.Fatal(err)
		}
		stat, err := s.app.store.get(ctx, "day_stat", key)
		if err != nil || integer(stat, "t") != 1 || integer(stat, "u") != 1 {
			t.Fatal(stat, err)
		}
		var count int
		if err = s.app.store.db.QueryRow(`SELECT COUNT(*) FROM polaris_readings WHERE monitor_id='m'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if pass == 0 && count != 1 || pass == 1 && count != 0 {
			t.Fatalf("pass %d remaining %d", pass, count)
		}
	}
}
func TestConcurrentDeleteAndArchiveLeavesNoStats(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	day := time.Now().Unix()/86400*86400 - 2*86400
	if err := s.app.store.put(ctx, "config", "settings", Object{"retention.detailDays": 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.app.store.put(ctx, "monitor", "race", Object{"id": "race", "active": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.app.store.db.Exec(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES('race',?,1,1,0,'','{}')`, day+1); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan error, 2)
	go func() { <-start; done <- s.app.rollupHistory(ctx, true) }()
	go func() {
		<-start
		code, _ := s.request(t, "DELETE", "/api/monitors/race", nil, true)
		if code != 200 {
			done <- fmt.Errorf("delete HTTP %d", code)
			return
		}
		done <- nil
	}()
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	stats, err := s.app.store.list(ctx, "day_stat")
	if err != nil || len(stats) != 0 {
		t.Fatal(stats, err)
	}
	var count int
	if err = s.app.store.db.QueryRow(`SELECT COUNT(*) FROM polaris_readings WHERE monitor_id='race'`).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
}
func TestCleanupExpiresUndeliveredNotifications(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	old := time.Now().Unix() - 8*86400
	if err := s.app.store.put(ctx, "outbox", "old", Object{"id": "old", "state": "pending", "created_at": old, "next_at": time.Now().Unix() + 3600}); err != nil {
		t.Fatal(err)
	}
	if err := s.app.rollupHistory(ctx, true); err != nil {
		t.Fatal(err)
	}
	row, err := s.app.store.get(ctx, "outbox", "old")
	if err != nil || str(row, "state") != "failed" {
		t.Fatal(row, err)
	}
}
