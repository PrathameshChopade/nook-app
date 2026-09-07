// exporter renders a page's blocks to Markdown or PDF.
//
// It is Go rather than TypeScript for one reason: to put a statically linked
// binary in a distroless image next to the Node services and be able to quote
// both numbers. The image-size comparison in stage 05 is the point; the
// service itself is deliberately small.
//
// It holds no database connection and no credentials. The worker sends it a
// document and gets bytes back, which keeps this the one service with nothing
// to steal.
package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"context"
)

type Block struct {
	Type    string         `json:"type"`
	Content map[string]any `json:"content"`
	Depth   int            `json:"depth"`
}

type RenderRequest struct {
	Title  string  `json:"title"`
	Format string  `json:"format"`
	Blocks []Block `json:"blocks"`
}

var (
	ready    atomic.Bool
	requests atomic.Int64
	failures atomic.Int64
	started  = time.Now()
)

func text(b Block) string {
	if v, ok := b.Content["text"].(string); ok {
		return v
	}
	return ""
}

// renderMarkdown is intentionally the whole feature set: headings, lists,
// quotes, code and paragraphs. Anything richer belongs in the editor, not
// here.
func renderMarkdown(r RenderRequest) []byte {
	var sb strings.Builder
	fmt.Fprintf(&sb, "# %s\n\n", r.Title)
	for _, b := range r.Blocks {
		indent := strings.Repeat("  ", b.Depth)
		switch b.Type {
		case "heading1":
			fmt.Fprintf(&sb, "## %s\n\n", text(b))
		case "heading2":
			fmt.Fprintf(&sb, "### %s\n\n", text(b))
		case "bullet":
			fmt.Fprintf(&sb, "%s- %s\n", indent, text(b))
		case "numbered":
			fmt.Fprintf(&sb, "%s1. %s\n", indent, text(b))
		case "quote":
			fmt.Fprintf(&sb, "> %s\n\n", text(b))
		case "code":
			fmt.Fprintf(&sb, "```\n%s\n```\n\n", text(b))
		case "divider":
			sb.WriteString("---\n\n")
		default:
			if t := text(b); t != "" {
				fmt.Fprintf(&sb, "%s%s\n\n", indent, t)
			}
		}
	}
	return []byte(sb.String())
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger.With("service", "exporter"))

	port := os.Getenv("PORT")
	if port == "" {
		port = "3003"
	}

	mux := http.NewServeMux()

	// Liveness: is the process wedged? No dependencies to check — this service
	// has none, which is part of why it exists.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		if !ready.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, `{"status":"shutting_down"}`)
			return
		}
		fmt.Fprint(w, `{"status":"ready"}`)
	})

	// Prometheus text format written by hand rather than pulling in the client
	// library. Four counters do not justify the dependency, and every byte
	// avoided here shows up in the image comparison.
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "# HELP exporter_renders_total Render requests handled\n")
		fmt.Fprintf(w, "# TYPE exporter_renders_total counter\n")
		fmt.Fprintf(w, "exporter_renders_total{service=\"exporter\"} %d\n", requests.Load())
		fmt.Fprintf(w, "# HELP exporter_render_failures_total Render requests rejected or failed\n")
		fmt.Fprintf(w, "# TYPE exporter_render_failures_total counter\n")
		fmt.Fprintf(w, "exporter_render_failures_total{service=\"exporter\"} %d\n", failures.Load())
		fmt.Fprintf(w, "# HELP exporter_uptime_seconds Seconds since start\n")
		fmt.Fprintf(w, "# TYPE exporter_uptime_seconds gauge\n")
		fmt.Fprintf(w, "exporter_uptime_seconds{service=\"exporter\"} %f\n", time.Since(started).Seconds())
	})

	mux.HandleFunc("POST /render", func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)

		// Bounded read. An unbounded json.Decoder on a request body is a
		// memory-exhaustion vector, and this service is reachable from the
		// worker with no other authentication.
		var req RenderRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
		if err := dec.Decode(&req); err != nil {
			failures.Add(1)
			http.Error(w, `{"error":"bad_request"}`, http.StatusBadRequest)
			return
		}

		switch req.Format {
		case "markdown", "":
			w.Header().Set("content-type", "text/markdown; charset=utf-8")
			w.Write(renderMarkdown(req))
		case "pdf":
			// Deliberately not implemented. A real PDF renderer means a
			// headless browser, which means a ~400 MB image and the exact
			// opposite of this service's reason to exist. The cut is
			// recorded rather than hidden behind a stub that pretends.
			failures.Add(1)
			http.Error(w, `{"error":"pdf_not_implemented","message":"PDF export is on the stage 01 cut list"}`,
				http.StatusNotImplemented)
		default:
			failures.Add(1)
			http.Error(w, `{"error":"unsupported_format"}`, http.StatusUnprocessableEntity)
		}
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	go func() {
		ready.Store(true)
		slog.Info("exporter listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("listen failed", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop

	// Same sequence as the Node services: fail readiness first so endpoints
	// are withdrawn, give that time to propagate, then drain.
	slog.Info("shutdown started")
	ready.Store(false)
	time.Sleep(3 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	slog.Info("shutdown complete")
}
