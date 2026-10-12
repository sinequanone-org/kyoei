"""Signed research events between institution nodes.

A node signs each event with its institution key and posts it to one named peer's
loopback relay. Challenges, dissents and withdrawals go to every trusted peer.
Reliance (`rely`), `affected`, `blocked` and `signoff` events go only to the
institution concerned. The peer checks the signature against the pinned
institution key, then computes its own notices from its own records. No event
carries a notice body or another institution's claim evidence. The parent process
never holds another institution's store.
"""
import json
import re
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from scripts.context_shards import digest, hash_value, identifier
from scripts.pq_crypto import SIGNATURE_HEX, VerifyingKey
from scripts.research_evidence import canonical
from scripts.task_data import require

EVENT = 'kyoei-research-event-ml-dsa-65-v1'
EVENT_FIELDS = ('domain', 'deployment', 'issuer', 'kind', 'purpose', 'payload', 'issued', 'expires')
KINDS = ('challenge', 'dissent', 'withdraw', 'rely', 'affected', 'blocked', 'signoff')
LOCAL_EVENT = re.compile(r'http://127\.0\.0\.1:\d+/research-event')
MAX_EVENT_BYTES = 16384
MAX_TEXT = 200


def sign_event(private_key, body):
    require(type(body) is dict and set(body) == set(EVENT_FIELDS), 'invalid-event')
    require(body['domain'] == EVENT and body['kind'] in KINDS, 'invalid-event')
    return {'body': body, 'signature': private_key.sign(canonical(body)).hex()}


def _text(value, limit=MAX_TEXT):
    require(type(value) is str and 1 <= len(value) <= limit, 'invalid-event')


def _version(value):
    require(type(value) is int and 1 <= value <= 999999, 'invalid-event')


def _payload(kind, payload):
    require(type(payload) is dict, 'invalid-event')
    fields = {
        'challenge': {'challenge_id', 'cited_result', 'banner'},
        'dissent': {'cited_result', 'actor', 'details'},
        'withdraw': {'cited_result'},
        'rely': {'artifact', 'version'},
        'affected': {'artifact', 'version', 'challenge_id', 'cited_result', 'banner', 'passage_sha256'},
        'blocked': {'artifact', 'version', 'cited_result'},
        'signoff': {'artifact', 'version', 'actor'},
    }[kind]
    require(set(payload) == fields, 'invalid-event')
    for name in ('challenge_id', 'cited_result', 'artifact', 'actor'):
        if name in payload:
            identifier(payload[name])
    if 'version' in payload:
        _version(payload['version'])
    if 'banner' in payload:
        _text(payload['banner'])
    if 'details' in payload:
        _text(payload['details'], 500)
    if 'passage_sha256' in payload:
        hash_value(payload['passage_sha256'])
    return payload


def parse_event(envelope):
    """Check the event shape. The caller checks the issuer key and the clock."""
    require(type(envelope) is dict and set(envelope) == {'body', 'signature'}, 'invalid-event')
    body, signature = envelope['body'], envelope['signature']
    require(type(body) is dict and set(body) == set(EVENT_FIELDS), 'invalid-event')
    require(body['domain'] == EVENT and body['deployment'] and body['kind'] in KINDS, 'invalid-event')
    identifier(body['deployment'])
    identifier(body['issuer'])
    identifier(body['purpose'])
    require(type(body['issued']) is int and type(body['expires']) is int, 'invalid-event')
    require(0 <= body['issued'] < body['expires'] <= body['issued'] + 300, 'invalid-event')
    _payload(body['kind'], body['payload'])
    require(type(signature) is str and len(signature) == SIGNATURE_HEX
            and all(char in '0123456789abcdef' for char in signature), 'invalid-event-signature')
    return body


def event_id(body):
    return digest(body)


def verify_signature(public, signature, body):
    try:
        VerifyingKey(public).verify(bytes.fromhex(signature), canonical(body))
    except Exception as exc:
        raise ValueError('invalid-event-signature') from exc


def local_url(url):
    require(type(url) is str and LOCAL_EVENT.fullmatch(url), 'relay-address-refused')
    return url


def post_event(url, envelope):
    local_url(url)
    raw = json.dumps(envelope).encode()
    require(len(raw) <= MAX_EVENT_BYTES, 'invalid-event')
    request = urllib.request.Request(url, data=raw, method='POST')
    request.add_header('Content-Type', 'application/json')
    last = None
    for _ in range(5):
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                reply = response.read(MAX_EVENT_BYTES + 1)
            require(len(reply) <= MAX_EVENT_BYTES, 'invalid-event')
            parsed = json.loads(reply)
            require(type(parsed) is dict, 'invalid-event')
            return parsed
        except urllib.error.HTTPError as exc:
            detail = exc.read(1024)
            try:
                parsed = json.loads(detail)
                message = parsed.get('error', 'relay-refused')
            except (json.JSONDecodeError, AttributeError):
                message = 'relay-refused'
            raise ValueError(message) from exc
        except (urllib.error.URLError, OSError) as exc:
            last = exc
            threading.Event().wait(0.05)
    raise ValueError('relay-unavailable') from last


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/research-event':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_EVENT_BYTES:
            self._reply(400, {'error': 'invalid-event'})
            return
        raw = self.rfile.read(length)
        try:
            result = self.server.store.accept_signed_event(json.loads(raw))
        except (ValueError, json.JSONDecodeError, KeyError, TypeError) as exc:
            self._reply(400, {'error': str(exc) if isinstance(exc, ValueError) else 'invalid-event'})
            return
        except Exception as exc:
            self._reply(500, {'error': 'relay-node-error'})
            raise
        # Events this one caused leave from here, so a chain across nodes never waits on a busy parent.
        sent = flush(self.server.store)
        self._reply(200, dict(result, onward=sent))

    def _reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


class _Server(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, store):
        self.store = store
        super().__init__(('127.0.0.1', 0), _Handler)


def flush(store):
    """Post every queued event to its one recipient. A refused event is dropped and counted."""
    sent = dict(delivered=0, refused=[], unavailable=0)
    for sequence, recipient, envelope in store.claim_events():
        url = store.peer_urls.get(recipient)
        if url is None:
            store.unsent(sequence)
            sent['unavailable'] += 1
            continue
        try:
            reply = post_event(url, envelope)
        except ValueError as exc:
            if str(exc) == 'relay-unavailable':
                store.unsent(sequence)
                sent['unavailable'] += 1
                continue
            sent['refused'].append(dict(recipient=recipient, kind=envelope['body']['kind'], error=str(exc)))
            store.refused_by_peer(sequence, recipient, envelope['body']['kind'], str(exc))
            continue
        if reply.get('status') in ('accepted', 'replayed'):
            store.sent(sequence)
            sent['delivered'] += 1
        else:
            sent['refused'].append(dict(recipient=recipient, kind=envelope['body']['kind'], error='relay-refused'))
            store.refused_by_peer(sequence, recipient, envelope['body']['kind'], 'relay-refused')
    return sent


def _node_main(conn, config):
    from scripts.f3_store import ResearchRepairStore
    from scripts.pq_crypto import SigningKey

    store = None
    server = None
    try:
        now = int(config['now'])
        store = ResearchRepairStore(
            config['path'], deployment=config['deployment'], institution=config['institution'],
            private_key=SigningKey(bytes.fromhex(config['seed'])),
            administrator=config['administrator'],
            administrator_public=config['administrator_public'],
            key_expires=int(config['key_expires']), max_age=int(config['max_age']),
            credential_fetch=lambda *_args: None, status_fetch=lambda *_args: None,
            clock=lambda: now)
        server = _Server(store)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        conn.send({'url': f'http://127.0.0.1:{server.server_address[1]}/research-event'})
        while True:
            message = conn.recv()
            op = message.get('op')
            if op == 'close':
                conn.send({'ok': True})
                return
            if op == 'peers':
                store.peer_urls = {name: local_url(url) for name, url in message['urls'].items()}
                conn.send({'ok': True})
                continue
            if op == 'handle':
                try:
                    result = store.handle(message['envelope'])
                except ValueError as exc:
                    # A refusal is an answer, not a crash: the node keeps serving.
                    conn.send({'refused': str(exc)})
                    continue
                conn.send({'result': result, 'relay': flush(store)})
                continue
            conn.send({'error': 'invalid-event'})
    except Exception as exc:
        try:
            conn.send({'error': str(exc)})
        except Exception:
            pass
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if store is not None:
            store.close()
        conn.close()


class RelayNode:
    """One institution process. The caller sends that institution's own requests."""

    def __init__(self, path, *, deployment, institution, private_key, administrator,
                 administrator_public, key_expires, max_age, now):
        import multiprocessing
        context = multiprocessing.get_context('spawn')
        self.conn, child = context.Pipe()
        config = dict(
            path=str(path), deployment=deployment, institution=institution,
            seed=private_key.private_bytes_raw().hex(), administrator=administrator,
            administrator_public=administrator_public, key_expires=key_expires,
            max_age=max_age, now=now)
        self.process = context.Process(target=_node_main, args=(child, config))
        self.institution = institution
        self.process.start()
        child.close()
        hello = self.conn.recv()
        if 'error' in hello:
            self.close()
            raise ValueError(hello['error'])
        self.url = local_url(hello['url'])

    def _call(self, message):
        self.conn.send(message)
        reply = self.conn.recv()
        if 'error' in reply:
            raise ValueError(reply['error'])
        return reply

    def set_peers(self, urls):
        self._call({'op': 'peers', 'urls': urls})

    def handle(self, envelope):
        """The institution's own signed request. Returns (result, relay) or raises the refusal."""
        require(type(envelope) is dict and type(envelope.get('body')) is dict
                and envelope['body'].get('node') == self.institution, 'wrong-node')
        self.conn.send({'op': 'handle', 'envelope': envelope})
        reply = self.conn.recv()
        if 'refused' in reply:
            raise ValueError(reply['refused'])
        if 'error' in reply:
            raise RuntimeError(reply['error'])
        return reply['result'], reply['relay']

    def close(self):
        try:
            self.conn.send({'op': 'close'})
            self.conn.recv()
        except Exception:
            pass
        self.process.join(timeout=5)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
