//go:build release

package polaris

import (
	"embed"
	"io/fs"
)

//go:embed web/*
var frontendAssets embed.FS

func embeddedFrontend() fs.FS {
	frontend, err := fs.Sub(frontendAssets, "web")
	if err != nil {
		panic(err)
	}
	return frontend
}
