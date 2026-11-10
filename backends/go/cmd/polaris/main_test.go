// 验证监听失败以非零状态退出。
// Check nonzero exit after a listener failure.

package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestListenerFailureExitsNonzero(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "polaris")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cmd := exec.Command(binary, "-addr", listener.Addr().String(), "-data-dir", t.TempDir())
	output, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("bind failure returned zero: %s", output)
	}
	if strings.Contains(string(output), "Go listening") {
		t.Fatalf("reported ready before bind: %s", output)
	}
	missing := filepath.Join(t.TempDir(), "missing.sqlite")
	cmd = exec.Command(binary, "-migration", "preview", "-database-url", missing, "-data-dir", t.TempDir())
	cmd.Env = append(os.Environ(), "POLARIS_MIGRATION_TARGET=postgres://fixture:fixture@127.0.0.1/fixture?sslmode=disable")
	if output, err = cmd.CombinedOutput(); err == nil {
		t.Fatalf("missing migration source accepted: %s", output)
	}
	if _, err = os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("migration created source database: %v", err)
	}
}
