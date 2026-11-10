// 验证离线迁移命令、持久配置与退出结果。
// Check offline migration commands, persistent configuration, and exit results.

package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/XingLingQAQ/uptime/backends/go/internal/polaris"
)

func TestOfflineMigrationCLI(t *testing.T) {
	base := os.Getenv("POLARIS_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("POLARIS_TEST_POSTGRES_URL is not configured")
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() != "127.0.0.1" {
		t.Fatal("PostgreSQL fixture must use an isolated loopback cluster")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pg, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	random := make([]byte, 8)
	if _, err = rand.Read(random); err != nil {
		t.Fatal(err)
	}
	name := "polaris_go_cli_" + hex.EncodeToString(random)
	if _, err = pg.ExecContext(ctx, `CREATE DATABASE `+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pg.Exec(`DROP DATABASE ` + name + ` WITH (FORCE)`); _ = pg.Close() })
	u.Path = "/" + name
	target := u.String()
	dir := t.TempDir()
	source := filepath.Join(dir, "source.sqlite")
	store, err := polaris.OpenStore(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	sqlite, err := sql.Open("sqlite", source)
	if err != nil {
		t.Fatal(err)
	}
	defer sqlite.Close()
	if _, err = sqlite.Exec(`INSERT INTO polaris_documents(kind,id,data,updated_at) VALUES('monitor','fixture','{"id":"fixture","active":true}',1)`); err != nil {
		t.Fatal(err)
	}
	if _, err = sqlite.Exec(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES('fixture',?,1,1,0,'','{}')`, time.Now().Unix()-100*86400); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "polaris")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	run := func(mode string) (map[string]any, error, string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, binary, "-migration", mode, "-database-url", source, "-data-dir", dir, "-addr", listener.Addr().String())
		cmd.Env = append(os.Environ(), "POLARIS_MIGRATION_TARGET="+target, "POLARIS_CONCURRENCY=32")
		out, err := cmd.CombinedOutput()
		var result map[string]any
		if err == nil {
			if e := json.Unmarshal(out, &result); e != nil {
				t.Fatalf("invalid JSON: %v: %s", e, out)
			}
		}
		return result, err, string(out)
	}
	result, err, out := run("preview")
	if err != nil || result["targetNeedsInitialization"] != true {
		t.Fatalf("preview: %v %s", err, out)
	}
	dest, err := sql.Open("pgx", target)
	if err != nil {
		t.Fatal(err)
	}
	defer dest.Close()
	var tables int
	if err = dest.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=current_schema()`).Scan(&tables); err != nil || tables != 0 {
		t.Fatal(tables, err)
	}
	result, err, out = run("execute")
	if err != nil || result["copied"] != true {
		t.Fatalf("execute: %v %s", err, out)
	}
	_, err, out = run("execute")
	if err == nil || !strings.Contains(out, "target_not_empty") {
		t.Fatalf("repeat execute: %v %s", err, out)
	}
	var sourceReadings, targetReadings, rollups int
	if err = sqlite.QueryRow(`SELECT COUNT(*) FROM polaris_readings`).Scan(&sourceReadings); err != nil {
		t.Fatal(err)
	}
	if err = sqlite.QueryRow(`SELECT COUNT(*) FROM polaris_documents WHERE kind IN ('rollup_day','day_stat')`).Scan(&rollups); err != nil {
		t.Fatal(err)
	}
	if err = dest.QueryRowContext(ctx, `SELECT COUNT(*) FROM polaris_readings`).Scan(&targetReadings); err != nil {
		t.Fatal(err)
	}
	if sourceReadings != 1 || targetReadings != 1 || rollups != 0 {
		t.Fatalf("source=%d target=%d rollups=%d", sourceReadings, targetReadings, rollups)
	}
}
