// 使用 PostgreSQL 验证迁移与后续运行。
// Use PostgreSQL to check migration and subsequent operation.

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

func TestPostgresMigrationAndRuntime(t *testing.T) {
	base := os.Getenv("POLARIS_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("POLARIS_TEST_POSTGRES_URL is not configured")
	}
	u, e := url.Parse(base)
	if e != nil || u.Hostname() != "127.0.0.1" {
		t.Fatal("PostgreSQL fixture must use an isolated loopback cluster")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, e := sql.Open("pgx", base)
	if e != nil {
		t.Fatal(e)
	}
	name := "polaris_go_test_" + strings.ReplaceAll(uuid(), "-", "")
	if _, e = db.ExecContext(ctx, `CREATE DATABASE `+name); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _, _ = db.Exec(`DROP DATABASE ` + name + ` WITH (FORCE)`); _ = db.Close() })
	u.Path = "/" + name
	target := u.String()
	s := newUninitializedTestServer(t)
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": s.config.SetupKey, "username": "admin", "password": "migrated-password"}, false)
	expectStatus(t, code, 200, result)
	id := s.createMonitor(t, "push", "", nil)
	code, result = s.request(t, "POST", "/api/admin/database-migration/preview", Object{"url": target}, true)
	expectStatus(t, code, 200, result)
	if result["targetNeedsInitialization"] != true || integer(result, "totalRows") < 3 {
		t.Fatal(result)
	}
	probe, e := sql.Open("pgx", target)
	if e != nil {
		t.Fatal(e)
	}
	defer probe.Close()
	var count int
	if e = probe.QueryRow(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'`).Scan(&count); e != nil || count != 0 {
		t.Fatal("preview changed target", count, e)
	}
	code, result = s.request(t, "POST", "/api/admin/database-migration/execute", Object{"url": target, "confirmed": true}, true)
	expectStatus(t, code, 200, result)
	if result["copied"] != true {
		t.Fatal(result)
	}
	code, result = s.request(t, "POST", "/api/admin/database-migration/execute", Object{"url": target, "confirmed": true}, true)
	expectStatus(t, code, 400, result)
	if str(result, "error") != "target_not_empty" {
		t.Fatal("populated target was not protected", result)
	}
	config := s.config
	config.DatabaseURL = target
	pg := openTestServer(t, config)
	code, result = pg.request(t, "POST", "/api/auth/login", Object{"username": "admin", "password": "migrated-password"}, false)
	expectStatus(t, code, 200, result)
	code, result = pg.request(t, "GET", "/api/monitors", nil, false)
	expectStatus(t, code, 200, result)
	if len(array(result["monitors"])) != 1 || str(object(array(result["monitors"])[0]), "id") != id {
		t.Fatal("migration lost UUID", result)
	}
	monitor, e := pg.app.store.get(context.Background(), "monitor", id)
	if e != nil {
		t.Fatal(e)
	}
	if e = pg.app.store.put(context.Background(), "push", id, Object{"ts": time.Now().Unix(), "status": 1, "message": ""}); e != nil {
		t.Fatal(e)
	}
	if e = pg.app.passiveCheck(context.Background(), monitor); e != nil {
		t.Fatal(e)
	}
	points, e := pg.app.readings(context.Background(), id, 0, 10)
	if e != nil || len(points) != 1 {
		t.Fatal("PG reading write failed", points, e)
	}
	code, result = pg.request(t, "GET", "/api/admin/usage", nil, true)
	expectStatus(t, code, 200, result)
	if str(object(object(result["runtime"])["database"]), "type") != "postgres" {
		t.Fatal(result)
	}
}
