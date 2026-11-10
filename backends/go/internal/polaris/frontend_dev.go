//go:build !release

package polaris

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

func embeddedFrontend() fs.FS {
	// 源码运行时按文件位置定位资源，避免依赖启动目录。
	// Locate checkout assets from this file rather than the working directory.
	_, source, _, ok := runtime.Caller(0)
	if !ok || !filepath.IsAbs(source) {
		return nil
	}
	return os.DirFS(filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "public"))
}
