// 验证离线复制与迁移后的连接选择。
// Check offline copying and connection selection after migration.

package polaris

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestOfflineMigration(t *testing.T) {
	base := os.Getenv("POLARIS_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("POLARIS_TEST_POSTGRES_URL is not configured")
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() != "127.0.0.1" {
		t.Fatal("PostgreSQL fixture must use an isolated loopback cluster")
	}
	db, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	name := "polaris_go_offline_" + strings.ReplaceAll(uuid(), "-", "")
	if _, err = db.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DROP DATABASE ` + name + ` WITH (FORCE)`); _ = db.Close() })
	u.Path = "/" + name
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	app, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if err = app.store.put(context.Background(), "monitor", "fixture", Object{"id": "fixture", "active": true}); err != nil {
		t.Fatal(err)
	}
	preview, err := app.MigrateOffline(context.Background(), u.String(), false)
	if err != nil || preview["targetNeedsInitialization"] != true {
		t.Fatal(preview, err)
	}
	result, err := app.MigrateOffline(context.Background(), u.String(), true)
	if err != nil || result["copied"] != true {
		t.Fatal(result, err)
	}
	if _, err = app.MigrateOffline(context.Background(), u.String(), true); err == nil || err.Error() != "target_not_empty" {
		t.Fatal(err)
	}
	cfg.DatabaseURL = u.String()
	pg, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	ctx := context.Background()
	now := time.Now().Unix()
	if err = pg.store.put(ctx, "probe_job", "job", Object{"agent_id": "agent", "monitor_id": "fixture", "state": "pending", "scheduled_at": now}); err != nil {
		t.Fatal(err)
	}
	jobs, err := pg.store.queueDocuments(ctx, pg.store.db, "probe_job", "agent_id", "agent", false, "", 128)
	if err != nil || len(jobs) != 1 {
		t.Fatal(jobs, err)
	}
	if err = pg.store.put(ctx, "config", "settings", Object{"retention.detailDays": 1}); err != nil {
		t.Fatal(err)
	}
	day := now/86400*86400 - 2*86400
	for _, item := range []struct {
		ts     int64
		status int
	}{{day + 1, 0}, {day + 10, 1}, {day + 60, 0}} {
		if _, err = pg.store.db.ExecContext(ctx, `INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES($1,$2,$3,1,0,'','{}')`, "fixture", item.ts, item.status); err != nil {
			t.Fatal(err)
		}
	}
	if err = pg.rollupHistory(ctx, true); err != nil {
		t.Fatal(err)
	}
	stat, err := pg.store.get(ctx, "day_stat", "fixture:"+time.Unix(day, 0).UTC().Format("2006-01-02"))
	if err != nil || integer(stat, "t") != 2 || integer(stat, "u") != 1 {
		t.Fatal(stat, err)
	}

}
