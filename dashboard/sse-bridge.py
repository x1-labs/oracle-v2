#!/usr/bin/env python3
"""
SSE Bridge v2 — streams Docker relay events to the dashboard.
Tails docker logs, parses sign/submit events, broadcasts via SSE.
Port: 8282
"""

import json, time, threading, subprocess, re, queue
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8282
clients_queue = []
lock = threading.Lock()

ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')

def strip_ansi(s):
    return ANSI_RE.sub('', s).replace('✅', '').replace('──', '').strip()

def parse_log_line(container, raw_line):
    line = strip_ansi(raw_line).strip()
    if not line:
        return None

    ts_match = re.match(r'\[(\d{2}:\d{2}:\d{2})\]\s*\[([^\]]+)\]\s*(.*)', line)
    if not ts_match:
        return None

    ts, client_id, content = ts_match.groups()
    content = content.strip()

    # Round marker: "Round 5"
    if 'Round' in content:
        round_match = re.search(r'Round\s+(\d+)', content)
        if round_match:
            return {
                "type": "round",
                "client": client_id,
                "round": int(round_match.group(1)),
                "timestamp": ts,
            }

    # Feed info: "Feed #541 [pyth:3 mexc:6 ...]"
    if 'Feed #' in content:
        feed_match = re.search(r'Feed #(\d+)\s*\[([^\]]*)\]', content)
        if feed_match:
            return {
                "type": "feed",
                "client": client_id,
                "feed_num": int(feed_match.group(1)),
                "sources": feed_match.group(2),
                "timestamp": ts,
            }

    # Price signed: "BTC  $71,253.19  signed  [KRA+COI+PYT+MEX+KUC]"
    price_match = re.match(r'\s*(\S+)\s+\$?([\d,.\-]+)\s+signed\s*(?:\[([^\]]*)\])?', content)
    if price_match:
        sym = price_match.group(1)
        price_str = price_match.group(2).replace(',', '')
        sources = price_match.group(3) or ''
        try:
            price = float(price_str)
        except:
            return None
        return {
            "type": "price",
            "client": client_id,
            "symbol": sym,
            "price": price,
            "sources": sources,
            "timestamp": ts,
        }

    # On-chain submission: "ON-CHAIN  TX: 3qkWE2..."
    if 'ON-CHAIN' in content:
        tx_match = re.search(r'TX:\s*(\S+)', content)
        tx = tx_match.group(1).rstrip('.') if tx_match else 'unknown'
        return {
            "type": "onchain",
            "client": client_id,
            "tx": tx,
            "timestamp": ts,
        }

    # Total summary: "Total: 7 signed, 7 submitted, 0 errors"
    total_match = re.match(r'\s*Total:\s*(\d+)\s+signed,\s*(\d+)\s+submitted,\s*(\d+)\s+errors', content)
    if total_match:
        return {
            "type": "summary",
            "client": client_id,
            "signed": int(total_match.group(1)),
            "submitted": int(total_match.group(2)),
            "errors": int(total_match.group(3)),
            "timestamp": ts,
        }

    # Vault status
    if 'OpenBao' in content:
        return {
            "type": "status",
            "client": client_id,
            "message": content,
            "timestamp": ts,
        }

    return None

def broadcast(event):
    data = f"data: {json.dumps(event)}\n\n"
    with lock:
        dead = []
        for q in clients_queue:
            try:
                q.put_nowait(data)
            except:
                dead.append(q)
        for q in dead:
            clients_queue.remove(q)

def tail_container(name):
    """Tail a docker container's logs and parse events."""
    while True:
        try:
            proc = subprocess.Popen(
                ['docker', 'logs', '-f', '--tail', '0', name],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1
            )
            for line in proc.stdout:
                event = parse_log_line(name, line)
                if event:
                    broadcast(event)
            proc.wait()
        except Exception as e:
            print(f"[sse-bridge] Error tailing {name}: {e}")
        time.sleep(3)

class SSEHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()

            q = queue.Queue(maxsize=100)
            with lock:
                clients_queue.append(q)

            # Send initial heartbeat
            self.wfile.write(b"data: {\"type\":\"connected\"}\n\n")
            self.wfile.flush()

            try:
                while True:
                    try:
                        data = q.get(timeout=15)
                        self.wfile.write(data.encode())
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with lock:
                    if q in clients_queue:
                        clients_queue.remove(q)
        elif self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "clients": len(clients_queue)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress request logging

# Start container tailers
containers = [f'oracle-relay-{i}' for i in range(1, 6)]
for c in containers:
    t = threading.Thread(target=tail_container, args=(c,), daemon=True)
    t.start()

print(f"[sse-bridge] Listening on :{PORT} — tailing {len(containers)} containers")
server = HTTPServer(('0.0.0.0', PORT), SSEHandler)
server.serve_forever()
