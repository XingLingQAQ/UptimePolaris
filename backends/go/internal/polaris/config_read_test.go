// 配置读取故障不得恢复为会放开公开页面或改变保留期的默认配置。
// Configuration read failures must not relax public access or change retention through defaults.
package polaris

import (
	"context"
	"testing"
	"time"
)

func TestConfigurationReadFailures(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	state := Object{"config": defaultPresentation(), "revision": "fixture"}
	if err := s.app.store.put(ctx, "config", "presentation", state); err != nil {
		t.Fatal(err)
	}
	object(state["config"])["retiredField"] = true
	if err := s.app.store.put(ctx, "config", "presentation", state); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/public/config", "/api/public/status", "/api/admin/presentation"} {
		code, out := s.request(t, "GET", path, nil, true)
		expectStatus(t, code, 503, out)
	}
	if err := s.app.store.put(ctx, "config", "settings", Object{"retention.detailDays": 365}); err != nil {
		t.Fatal(err)
	}
	// 模拟设置文档无法解析；其余读数表仍可写，能发现错误的清理回退。
	// Leave reading tables usable while corrupting settings to expose fallback-driven cleanup.
	if _, err := s.app.store.db.ExecContext(ctx, "UPDATE polaris_documents SET data='[]' WHERE kind='config' AND id='settings'"); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-100 * 24 * time.Hour).Unix()
	if _, err := s.app.store.db.ExecContext(ctx, "INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES('fixture',?,1,1,200,'','{}')", old); err != nil {
		t.Fatal(err)
	}
	if err := s.app.rollupHistory(ctx, true); err == nil {
		t.Fatal("cleanup accepted unreadable settings")
	}
	var count int
	if err := s.app.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM polaris_readings WHERE monitor_id='fixture'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	for _, path := range []string{"/api/admin/settings", "/api/public/maintenance"} {
		code, out := s.request(t, "GET", path, nil, true)
		expectStatus(t, code, 503, out)
	}
}
