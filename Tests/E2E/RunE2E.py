"""End-to-end tests for the vaccine search portal (Design.md §7-2).

Starts `wrangler dev --local --env local` in fixture mode (synthetic data only, no real PII),
drives the page with Playwright and checks the 17 scenarios. On failure, the page HTML, a
screenshot and the raw HTTP results are saved under SearchPortal/logs/. The exit code is the
number of failed scenarios (2 = setup failure before any scenario ran is reported as 100).

Usage:
    python Tests/E2E/RunE2E.py [--port 8798] [--headed] [--only 1,3,7] [--keep-server] [--channel chrome|chromium]
                               [--backend worker|php]

--backend php starts the PHP version with `php -S` and Php/Tools/DevRouter.php instead of
wrangler; run `node Php/Tools/ExportFixture.mjs` once first so the PHP fixture exists.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

# Project root (SearchPortal/)
PROJECT_DIR = Path(__file__).resolve().parents[2]
# Failure evidence folder (gitignored because pages may contain data)
LOG_DIR = PROJECT_DIR / "logs"
# Wrangler CLI entry point, launched through node directly (no cmd/npx layers to orphan children)
WRANGLER_JS = PROJECT_DIR / "node_modules" / "wrangler" / "bin" / "wrangler.js"
# PHP (shared PHP hosting) backend: router for the built-in server and the synthetic fixture it serves
PHP_ROUTER = PROJECT_DIR / "Php" / "Tools" / "DevRouter.php"
PHP_FIXTURE = PROJECT_DIR / "Php" / "Tests" / "Fixture" / "FixtureData.json"
# Source of the PHP fixture (the export must not be older than this)
FIXTURE_SOURCE = PROJECT_DIR / "Src" / "Fixture.js"
# The server under test: label for messages, log file name and the fix to suggest when it is not the fixture
SERVER = {"label": "wrangler dev", "log": "E2E-wrangler.log",
          "hint": ".dev.vars に FIXTURE_MODE=\"1\" があるか確認してください"}
# Production hostname used to prove the dev bypass is fenced to localhost
PROD_HOST = "vaccine.example.org"
# Default timeout for UI expectations (ms)
TIMEOUT_MS = 8000
# Exit code used when the environment could not be set up at all
SETUP_FAILURE_EXIT = 100

# Raw HTTP results of the current scenario, dumped as evidence when it fails
RAW_RESULTS: list[dict] = []
# Attachment URLs whose expected 404/413/415 console line the current scenario allows
ALLOWED_CONSOLE_URLS: list = []


class SetupError(RuntimeError):
    """Raised when the dev server cannot be started or is not the expected fixture server."""


def port_in_use(port: int) -> bool:
    """True if something already listens on 127.0.0.1:port."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def start_server(port: int, backend: str = "worker") -> tuple[subprocess.Popen, object]:
    """Launch the fixture server (wrangler dev, or PHP's built-in server for the shared PHP hosting backend) as our own child."""
    # Never test against (or kill) a server someone else started on this port
    if port_in_use(port):
        raise SetupError(f"ポート {port} は使用中です．別のサーバを相手にしないため中止します（--port で変更可）")
    LOG_DIR.mkdir(exist_ok=True)
    env = None
    if backend == "php":
        SERVER.update(label="php -S", log="E2E-php.log",
                      hint="node Php/Tools/ExportFixture.mjs を再実行してフィクスチャを作り直してください")
        if shutil.which("php") is None:
            raise SetupError("php が見つかりません．PHP 8.3 以上をインストールして PATH を通してください")
        # The PHP fixture is exported from Src/Fixture.js; refuse a missing or outdated export
        if not PHP_FIXTURE.is_file():
            raise SetupError(f"PHP 用フィクスチャがありません．{SERVER['hint']}")
        if PHP_FIXTURE.stat().st_mtime < FIXTURE_SOURCE.stat().st_mtime:
            raise SetupError(f"PHP 用フィクスチャが Src/Fixture.js より古いです．{SERVER['hint']}")
        # Fixture caches from an earlier run would survive (the cache is a file, not memory): start clean
        cache_dir = LOG_DIR / "PhpCache"
        shutil.rmtree(cache_dir, ignore_errors=True)
        if cache_dir.exists():
            raise SetupError(f"前回のキャッシュを消せません（php が残っている可能性）: {cache_dir}")
        # Load the extensions shared PHP hosting has enabled (a php.ini-less local install loads none of them)
        # Only add -d flags for extensions that are not loaded yet: on Linux (setup-php, distro packages) they
        # come from php.ini/conf.d and forcing extension_dir=<php dir>/ext would break every one of them
        required_exts = ("intl", "mbstring", "openssl", "curl", "gd")
        probe = "echo PHP_BINARY, PHP_EOL, implode(',', array_map('strtolower', get_loaded_extensions()));"
        probe_lines = subprocess.run(["php", "-r", probe], capture_output=True, text=True).stdout.splitlines()
        php_binary = probe_lines[0].strip() if probe_lines else ""
        loaded = set(probe_lines[1].split(",")) if len(probe_lines) > 1 else set()
        missing = [ext for ext in required_exts if ext not in loaded]
        ext_flags = []
        if missing:
            # A php.ini-less Windows install: point at the bundled ext/ folder and load what is missing
            ext_flags = ["-d", f"extension_dir={Path(php_binary).parent / 'ext'}"]
            for ext in missing:
                ext_flags += ["-d", f"extension={ext}"]
        command = ["php", *ext_flags, "-S", f"127.0.0.1:{port}", str(PHP_ROUTER)]
        # Drop every inherited VACCINE_* setting (e.g. a real key path) and pin the key path to a file that
        # does not exist, so no request can ever reach the real sheet; caches and logs go to logs/
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("VACCINE_")}
        env.update({"FIXTURE_MODE": "1", "DEV_BYPASS_AUTH": "1", "FIXTURE_DATA_PATH": str(PHP_FIXTURE),
                    "VACCINE_SA_JSON_PATH": str(cache_dir / "NoServiceAccount.json"),
                    "VACCINE_CACHE_DIR": str(cache_dir), "VACCINE_LOG_DIR": str(LOG_DIR / "PhpLogs")})
    else:
        if not WRANGLER_JS.is_file():
            raise SetupError("node_modules に wrangler がありません．先に npm install を実行してください")
        command = ["node", str(WRANGLER_JS), "dev", "--local", "--port", str(port), "--env", "local"]
    log = open(LOG_DIR / SERVER["log"], "w", encoding="utf-8")
    # A new process group lets taskkill /T reach the whole tree (node -> workerd, or php) even if intermediates exit
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    try:
        proc = subprocess.Popen(command, cwd=PROJECT_DIR, stdout=log, stderr=subprocess.STDOUT, env=env,
                                creationflags=flags, start_new_session=sys.platform != "win32")
    except OSError as exc:
        log.close()
        raise SetupError(f"{SERVER['label']} を起動できません: {exc}") from exc
    return proc, log


def log_tail(lines: int = 15) -> str:
    """Last lines of the test server's log, for setup error messages."""
    path = LOG_DIR / SERVER["log"]
    if not path.is_file():
        return ""
    return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])


def wait_for_server(proc: subprocess.Popen, base_url: str, timeout_s: float = 90.0) -> None:
    """Poll /api/me until our dev server answers 200; fail fast if wrangler exits."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        # Our own process died: report its log instead of waiting out the timeout
        if proc.poll() is not None:
            raise SetupError(f"{SERVER['label']} が終了しました（code={proc.returncode}）\n{log_tail()}")
        try:
            with urllib.request.urlopen(f"{base_url}/api/me", timeout=3) as res:
                if res.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(1)
    raise SetupError(f"{SERVER['label']} が {timeout_s:.0f} 秒以内に起動しませんでした\n{log_tail()}")


def post_json(base: str, path: str, body: dict) -> tuple[int, dict]:
    """POST a JSON body and return (status, parsed JSON)."""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def verify_fixture_server(base: str, fx: dict) -> None:
    """Refuse to run unless the server serves the synthetic fixture (never real patient data)."""
    status, everything = post_json(base, "/api/search", {"pageSize": 50})
    if status != 200 or everything.get("total") != fx["total"]:
        raise SetupError(f"フィクスチャモードではありません（status={status}, total={everything.get('total')}）．"
                         f"{SERVER['hint']}")
    status, yamada = post_json(base, "/api/search", {"q": "山田太郎"})
    items = yamada.get("items") or []
    if status != 200 or len(items) != 1 or items[0].get("name") != fx["yamada"]["name"]:
        raise SetupError("フィクスチャの目印（2行目の山田　太郎）が一致しません．実データの可能性があるため中止します")


def stop_server(proc: subprocess.Popen, log) -> None:
    """Stop only the process tree we started (never kill by port number)."""
    try:
        if sys.platform == "win32":
            # /T kills the children of our own PID only (node -> workerd, or php)
            result = subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, text=True)
            if result.returncode != 0 and proc.poll() is None:
                print(f"警告: taskkill に失敗しました（PID {proc.pid}）: {result.stderr.strip()}")
        else:
            import os
            import signal
            os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        print(f"警告: {SERVER['label']}（PID {proc.pid}）が15秒以内に終了しませんでした．残存プロセスを確認してください")
    except ProcessLookupError:
        pass
    finally:
        log.close()


def save_evidence(page: Page, name: str) -> None:
    """Write the failing page's HTML, a PNG screenshot and raw HTTP results to logs/."""
    LOG_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = LOG_DIR / f"E2E-{name}-{stamp}"
    try:
        base.with_suffix(".html").write_text(page.content(), encoding="utf-8")
        page.screenshot(path=str(base.with_suffix(".png")), full_page=True)
        # Header/status scenarios never render a page, so their HTTP results are the useful evidence
        if RAW_RESULTS:
            base.with_suffix(".json").write_text(json.dumps(RAW_RESULTS, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:  # Evidence is best effort; never mask the real failure
        print(f"  証跡の保存に失敗: {exc}")


# ---------------------------------------------------------------- page helpers


def result_rows(page: Page):
    """Locator for the rendered result rows."""
    return page.get_by_test_id("result-row")


def is_search_response(response) -> bool:
    """True for the POST /api/search response."""
    return response.url.endswith("/api/search") and response.request.method == "POST"


def after_search(page: Page, action) -> None:
    """Run a UI action, wait for the search response it triggers, then for the list to settle."""
    with page.expect_response(is_search_response, timeout=TIMEOUT_MS):
        action()
    # aria-busy flips back to false once the new results are rendered
    expect(page.locator("#results")).to_have_attribute("aria-busy", "false")


def result_total(page: Page) -> int:
    """Read the total hit count from the result header (e.g. 「1,234件」)."""
    text = page.get_by_test_id("result-count").inner_text()
    match = re.search(r"([\d,]+)\s*件", text)
    if not match:
        raise AssertionError(f"件数表示を読めません: {text!r}")
    return int(match.group(1).replace(",", ""))


def assert_total(page: Page, expected: int) -> None:
    """Assert the settled result header shows the expected total."""
    actual = result_total(page)
    assert actual == expected, f"件数 {actual}（期待 {expected}）"


def row_numbers(page: Page) -> list[int]:
    """Sheet row numbers of the visible result rows."""
    return [int(n) for n in result_rows(page).evaluate_all("els => els.map(e => e.dataset.rowNumber)")]


def open_home(page: Page, base_url: str, fx: dict) -> None:
    """Load the page fresh and wait for the initial list (recent 50 = all fixture rows)."""
    after_search(page, lambda: page.goto(base_url + "/"))
    assert_total(page, fx["total"])


def search(page: Page, text: str) -> None:
    """Type a search term and wait for the debounced search to finish."""
    after_search(page, lambda: page.get_by_test_id("search-input").fill(text))


def choose_option(page: Page, chip: str, value: str) -> None:
    """Open a single-select chip popover and pick an option by its value."""
    page.get_by_test_id(f"chip-{chip}").click()
    after_search(page, lambda: page.locator(f'[data-testid="popover-option"][data-value="{value}"]').click())


def apply_range(page: Page, chip: str, low: str, high: str) -> None:
    """Fill a from/to range popover and apply it."""
    page.get_by_test_id(f"chip-{chip}").click()
    page.get_by_test_id(f"pop-{chip}-from").fill(low)
    page.get_by_test_id(f"pop-{chip}-to").fill(high)
    after_search(page, lambda: page.get_by_test_id("popover-apply").click())


def raw_request(base: str, path: str, host: str | None = None, accept: str | None = None,
                authorization: str | None = None) -> tuple[int, str, dict]:
    """GET a path directly, optionally spoofing the Host / Authorization headers; record and return the result."""
    req = urllib.request.Request(base + path)
    if host:
        req.add_header("Host", host)
    if accept:
        req.add_header("Accept", accept)
    if authorization:
        req.add_header("Authorization", authorization)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            status, body, headers = res.status, res.read().decode("utf-8", "replace"), dict(res.headers)
    except urllib.error.HTTPError as err:
        status, body, headers = err.code, err.read().decode("utf-8", "replace"), dict(err.headers)
    # Keep the result for failure evidence (fixture server only, so no real data)
    RAW_RESULTS.append({"path": path, "host": host, "status": status, "headers": headers, "body": body[:500]})
    return status, body, headers


# ---------------------------------------------------------------- scenarios


def s01_name_without_space(page: Page, base: str, fx: dict) -> None:
    """「山田太郎」 without a space finds 「山田　太郎」."""
    open_home(page, base, fx)
    search(page, "山田太郎")
    assert_total(page, 1)
    assert row_numbers(page) == [fx["yamada"]["rowNumber"]]


def s02_phone_without_hyphen(page: Page, base: str, fx: dict) -> None:
    """Phone number without hyphens finds the row."""
    open_home(page, base, fx)
    search(page, "09000000001")
    assert_total(page, 1)
    assert row_numbers(page) == [fx["yamada"]["rowNumber"]]


def s03_katakana_to_hiragana(page: Page, base: str, fx: dict) -> None:
    """Katakana 「ヤマダ」 matches the hiragana furigana 「やまだ」."""
    open_home(page, base, fx)
    search(page, "ヤマダ")
    assert_total(page, 1)
    expect(result_rows(page).first).to_contain_text("やまだ")


def s04_kind_category_age(page: Page, base: str, fx: dict) -> None:
    """種別=コロナ + 区分=公費 + 年齢 65-100 gives the known count."""
    spec = fx["coronaPublicAge65to100"]
    open_home(page, base, fx)
    choose_option(page, "kind", spec["kind"])
    choose_option(page, "category", spec["category"])
    apply_range(page, "age", str(spec["ageMin"]), str(spec["ageMax"]))
    assert_total(page, spec["count"])
    assert sorted(row_numbers(page)) == sorted(spec["rowNumbers"])


def s05_visit_date_range(page: Page, base: str, fx: dict) -> None:
    """受診日 from/to excludes out-of-range and unparsable dates."""
    spec = fx["visitRange"]
    open_home(page, base, fx)
    apply_range(page, "visit", spec["visitFrom"], spec["visitTo"])
    assert_total(page, spec["count"])
    rows = row_numbers(page)
    assert sorted(rows) == sorted(spec["rowNumbers"]), rows
    assert fx["unparsableVisitDateRowNumber"] not in rows


def s06_flagged_only(page: Page, base: str, fx: dict) -> None:
    """要確認のみ shows exactly the flagged rows, each dot labelled with the right meaning."""
    open_home(page, base, fx)
    after_search(page, lambda: page.get_by_test_id("chip-flagged").click())
    assert_total(page, fx["flagged"])
    # Map each row to its flag dot label (role=img dots only, not other labelled elements)
    labels = dict(result_rows(page).evaluate_all(
        "els => els.map(e => [e.dataset.rowNumber,"
        " (e.querySelector('.flag-dot[role=\"img\"]') || {getAttribute: () => null}).getAttribute('aria-label')])"
    ))
    expected = {}
    for row in fx["redRowNumbers"]:
        expected[str(row)] = "判断不能"
    for row in fx["orangeRowNumbers"]:
        expected[str(row)] = "年齢不一致"
    for row in fx["yellowRowNumbers"]:
        expected[str(row)] = "推測"
    assert labels == expected, labels


def s07_drawer_open_close(page: Page, base: str, fx: dict) -> None:
    """Row click opens the drawer; Esc closes it and focus returns to the row."""
    open_home(page, base, fx)
    row = page.locator(f'[data-testid="result-row"][data-row-number="{fx["yamada"]["rowNumber"]}"]')
    row.click()
    drawer = page.get_by_test_id("drawer")
    expect(drawer).to_be_visible()
    expect(drawer).to_contain_text("やまだ")
    expect(drawer).to_contain_text(fx["yamada"]["phone"])
    page.keyboard.press("Escape")
    expect(drawer).to_be_hidden()
    focused = page.evaluate("document.activeElement && document.activeElement.dataset.rowNumber")
    assert focused == str(fx["yamada"]["rowNumber"]), focused


def s08_keyboard(page: Page, base: str, fx: dict) -> None:
    """`/` focuses search, arrows move to the 1st then 2nd row, Enter opens the drawer."""
    open_home(page, base, fx)
    order = row_numbers(page)
    # Drop focus without clicking at a coordinate that may hit a control
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.keyboard.press("/")
    assert page.evaluate("document.activeElement.dataset.testid") == "search-input"
    page.keyboard.press("ArrowDown")
    first = page.evaluate("document.activeElement.dataset.rowNumber")
    page.keyboard.press("ArrowDown")
    second = page.evaluate("document.activeElement.dataset.rowNumber")
    assert (first, second) == (str(order[0]), str(order[1])), (first, second, order[:2])
    page.keyboard.press("Enter")
    expect(page.get_by_test_id("drawer")).to_be_visible()


def s09_zero_results(page: Page, base: str, fx: dict) -> None:
    """A non-existent name shows 0件, the zero-result message and a clear button."""
    open_home(page, base, fx)
    search(page, fx["noHitQuery"])
    expect(page.get_by_test_id("zero-result")).to_be_visible()
    expect(page.get_by_test_id("zero-result")).to_contain_text("該当する記録がありません")
    expect(page.get_by_test_id("empty-clear")).to_be_visible()
    assert_total(page, 0)


def s10_mobile(page: Page, base: str, fx: dict) -> None:
    """390x844: bottom sheet, no horizontal scroll, tel: link present."""
    page.set_viewport_size({"width": 390, "height": 844})
    open_home(page, base, fx)
    overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert overflow <= 0, f"横スクロールが {overflow}px 発生"
    result_rows(page).first.click()
    drawer = page.get_by_test_id("drawer")
    expect(drawer).to_be_visible()
    box = drawer.bounding_box()
    # Bottom sheet spans the full viewport width
    assert box and box["width"] >= 380, box
    expect(page.get_by_test_id("phone-link")).to_have_attribute("href", re.compile(r"^tel:"))


def s11_unauthenticated(page: Page, base: str, fx: dict) -> None:
    """With a non-localhost Host the dev bypass is refused: 503 and no patient data."""
    # A self-made Basic header must not help either: nothing on a dev server ever checked that password
    fake_basic = "Basic " + base64.b64encode(b"intruder:guess").decode()
    for path in ("/", "/api/meta", f"/api/records/{fx['yamada']['rowNumber']}"):
        for authorization in (None, fake_basic):
            status, body, _ = raw_request(base, path, host=PROD_HOST, authorization=authorization)
            assert status == 503, f"{path} (auth={bool(authorization)}): {status}"
            # The refusal must come from the auth gate itself: a bypass that then fails to read the sheet
            # (sheet_unavailable) is also 503, so the reason is checked, not just the number
            if path.startswith("/api/"):
                try:
                    parsed = json.loads(body or "{}")
                except ValueError:
                    parsed = None
                assert isinstance(parsed, dict), f"{path} (auth={bool(authorization)}): JSON でない応答: {body[:80]}"
                code = (parsed.get("error") or {}).get("code")
                assert code == "access_not_configured", f"{path} (auth={bool(authorization)}): {code}"
            else:
                assert "認証の設定が完了していません" in body, f"{path} (auth={bool(authorization)})"
            # The refusal page must not leak any fixture patient field
            assert "山田" not in body and "090-0000" not in body and "<script" not in body.lower(), path


def s12_security_headers(page: Page, base: str, fx: dict) -> None:
    """Every response carries CSP, no-store and noindex; search terms travel only in the POST body."""
    for path in ("/", "/App.js", "/api/meta", "/api/me"):
        _, _, headers = raw_request(base, path)
        lower = {k.lower(): v for k, v in headers.items()}
        assert "frame-ancestors 'none'" in lower.get("content-security-policy", ""), path
        assert "no-store" in lower.get("cache-control", ""), path
        assert "noindex" in lower.get("x-robots-tag", ""), path
    # Record every request with method and body, then search through the UI
    requests: list[tuple[str, str, str]] = []
    page.on("request", lambda r: requests.append((r.method, urllib.parse.unquote(r.url), r.post_data or "")))
    open_home(page, base, fx)
    search(page, "山田太郎")
    assert_total(page, 1)
    searches = [r for r in requests if r[0] == "POST" and r[1].endswith("/api/search")]
    # The listener must actually have seen the search, otherwise the URL check below proves nothing
    assert any("山田太郎" in body for _, _, body in searches), searches
    forbidden = ("山田", "やまだ", "ヤマダ")
    assert not any(word in url for _, url, _ in requests for word in forbidden), [u for _, u, _ in requests]
    assert not any(word in urllib.parse.unquote(page.url) for word in forbidden), page.url


def open_detail(page: Page, base: str, fx: dict, row_number: int):
    """Open the drawer for a sheet row and return the drawer locator."""
    open_home(page, base, fx)
    page.locator(f'[data-testid="result-row"][data-row-number="{row_number}"]').click()
    drawer = page.get_by_test_id("drawer")
    expect(drawer).to_have_class(re.compile(r"\bis-open\b"))
    return drawer


def attachment_path(spec: dict) -> str:
    """Attachment endpoint path for a fixture spec."""
    return f"/api/records/{spec['rowNumber']}/attachments/{spec['index']}"


def s13_image_lightbox(page: Page, base: str, fx: dict) -> None:
    """Image attachment: thumbnail decodes, lightbox image decodes, zoom toggles, Esc returns focus."""
    spec = fx["attachments"]["image"]
    drawer = open_detail(page, base, fx, spec["rowNumber"])
    section = drawer.get_by_test_id("attachments-section")
    expect(section).to_be_visible()
    # A failed image swaps to an error card; assert none so a failure reports its real cause
    expect(drawer.get_by_test_id("attachment-error")).to_have_count(0)
    thumb = section.get_by_test_id("attachment-thumb")
    # is-loaded is set by the img load event; naturalWidth proves the bytes decoded
    expect(thumb).to_have_class(re.compile(r"\bis-loaded\b"))
    assert thumb.locator("img").evaluate("i => i.naturalWidth") > 0
    expect(section).to_contain_text(spec["label"])
    thumb.click()
    lightbox = page.get_by_test_id("lightbox")
    expect(lightbox).to_be_visible()
    # Focus moves into the dialog on open
    expect(page.get_by_test_id("lightbox-close")).to_be_focused()
    # The full-size image must load too (a failing GET would only add is-error)
    expect(lightbox).to_have_class(re.compile(r"\bis-loaded\b"))
    expect(lightbox).not_to_have_class(re.compile(r"\bis-error\b"))
    expect(page.get_by_test_id("lightbox-img")).to_have_js_property("complete", True)
    assert page.get_by_test_id("lightbox-img").evaluate("i => i.naturalWidth") > 0
    zoom = page.get_by_test_id("lightbox-zoom")
    zoom.click()
    expect(zoom).to_have_attribute("aria-pressed", "true")
    page.keyboard.press("Escape")
    expect(lightbox).to_be_hidden()
    # Esc closes only the lightbox: the drawer stays open and focus returns to the thumbnail
    expect(drawer).to_have_class(re.compile(r"\bis-open\b"))
    expect(thumb).to_be_focused()


def s14_pdf_iframe(page: Page, base: str, fx: dict) -> None:
    """PDF attachment: iframe loads the attachment URL, which serves application/pdf without sandbox."""
    spec = fx["attachments"]["pdf"]
    expected_path = attachment_path(spec)
    drawer = open_detail(page, base, fx, spec["rowNumber"])
    frame = drawer.get_by_test_id("attachment-iframe")
    expect(frame).to_be_visible()
    assert (frame.get_attribute("src") or "").endswith(expected_path), frame.get_attribute("src")
    # The wrapper gets is-loaded from the iframe load event
    expect(drawer.locator(".attachment-pdf.is-loaded")).to_have_count(1)
    expect(drawer.get_by_test_id("attachment-open-tab")).to_have_attribute("href", re.compile(re.escape(expected_path) + "$"))
    status, body, headers = raw_request(base, expected_path)
    lower = {k.lower(): v for k, v in headers.items()}
    assert status == 200 and lower.get("content-type", "").startswith("application/pdf"), (status, lower.get("content-type"))
    assert body.startswith("%PDF-"), body[:10]
    # Chrome's PDF viewer renders blank inside sandboxed documents, so PDFs must not carry sandbox
    assert "sandbox" not in lower.get("content-security-policy", ""), lower.get("content-security-policy")
    assert "frame-ancestors 'self'" in lower.get("content-security-policy", "")


def s15_unavailable_error(page: Page, base: str, fx: dict) -> None:
    """A Drive file not shared with the service account: HEAD answers 404 and the error card links to Drive."""
    spec = fx["attachments"]["unavailable"]
    path = attachment_path(spec)
    # Only this scenario expects the browser's resource-load error, and only for this URL
    ALLOWED_CONSOLE_URLS.append(re.compile(re.escape(path) + "$"))
    open_home(page, base, fx)
    with page.expect_response(lambda r: r.request.method == "HEAD" and r.url.endswith(path)) as probe:
        page.locator(f'[data-testid="result-row"][data-row-number="{spec["rowNumber"]}"]').click()
    assert probe.value.status == 404, probe.value.status
    drawer = page.get_by_test_id("drawer")
    card = drawer.get_by_test_id("attachment-error")
    expect(card).to_be_visible()
    expect(card).to_contain_text("VaccineFormFiles")
    link = drawer.get_by_test_id("attachment-drive-link")
    expect(link).to_have_attribute("href", spec["url"])
    expect(link).to_have_attribute("target", "_blank")
    expect(link).to_have_attribute("rel", re.compile("noopener"))


def assert_no_server_ids(detail_text: str) -> None:
    """Detail JSON returns display URLs but never the server-only file id list or per-attachment ids."""
    detail = json.loads(detail_text)
    assert "attachmentFileIds" not in detail, list(detail)
    assert all("fileId" not in a for a in detail.get("attachments", [])), detail.get("attachments")


def s16_attachment_icons_and_headers(page: Page, base: str, fx: dict) -> None:
    """Paperclip icons match the fixture rows; image responses are sandboxed; server-only ids stay hidden."""
    open_home(page, base, fx)
    rows_with_icon = result_rows(page).evaluate_all(
        "els => els.filter(e => e.querySelector('[data-testid=\"row-attachment-icon\"]')).map(e => Number(e.dataset.rowNumber))")
    assert sorted(rows_with_icon) == sorted(fx["attachments"]["rowNumbers"]), rows_with_icon
    # The accessible name is what screen readers announce
    expect(page.get_by_role("img", name="添付あり")).to_have_count(len(fx["attachments"]["rowNumbers"]))
    spec = fx["attachments"]["image"]
    path = attachment_path(spec)
    # Default and browser-like Accept (webp allowed); fixture mode never converts, so the format stays original
    for accept in (None, "image/avif,image/webp,*/*"):
        status, _, headers = raw_request(base, path, accept=accept)
        lower = {k.lower(): v for k, v in headers.items()}
        assert status == 200 and lower.get("content-type") == spec["mimeType"], (accept, status, lower.get("content-type"))
        assert "sandbox" in lower.get("content-security-policy", ""), lower.get("content-security-policy")
        assert lower.get("x-attachment-format") == spec["format"], (accept, lower.get("x-attachment-format"))
        assert "accept" in lower.get("vary", "").lower(), lower.get("vary")
        assert "no-store" in lower.get("cache-control", "")
    for row in (spec["rowNumber"], fx["attachments"]["unavailable"]["rowNumber"]):
        _, detail, _ = raw_request(base, f"/api/records/{row}")
        assert_no_server_ids(detail)
    # Out-of-range index is a plain 404
    status, _, _ = raw_request(base, f"/api/records/{spec['rowNumber']}/attachments/99")
    assert status == 404, status


def s17_session_expired(page: Page, base: str, fx: dict) -> None:
    """An expired Access session (302 to the Access login on another origin) shows the re-login banner, not a network error."""
    open_home(page, base, fx)
    access_login = "https://example-team.cloudflareaccess.com/cdn-cgi/access/login/vaccine.example.org"
    # Answer searches exactly like Access does for a request without a valid session, recording what was bounced
    fulfilled: list[str] = []

    def expire(route):
        fulfilled.append(route.request.post_data or "")
        route.fulfill(status=302, headers={"Location": access_login})

    page.route("**/api/search", expire)
    page.get_by_test_id("search-input").fill("山田")
    banner = page.get_by_test_id("error-banner")
    expect(banner).to_be_visible()
    expect(banner).to_contain_text("ログインの有効期限が切れました")
    # The old behaviour showed the network message; it must not come back
    expect(banner).not_to_contain_text("通信環境")
    # The banner comes from the very search that Access bounced
    assert any("山田" in body for body in fulfilled), fulfilled
    action = banner.get_by_test_id("error-action")
    expect(action).to_have_text(re.compile("ログインし直す"))
    # The button must reload the document (through Access in production), not merely retry the search
    page.unroute("**/api/search")
    page.evaluate("window.__s17BeforeReload = true")
    with page.expect_response(is_search_response):
        action.click()
    expect(page.locator("#results")).to_have_attribute("aria-busy", "false")
    assert page.evaluate("window.__s17BeforeReload === undefined"), "ページが再読み込みされていません"
    # A retry would keep 「山田」 and its narrowed count; a reload starts clean
    expect(page.get_by_test_id("search-input")).to_have_value("")
    assert_total(page, fx["total"])
    expect(banner).to_be_hidden()


SCENARIOS = [
    (1, "NameWithoutSpace", s01_name_without_space),
    (2, "PhoneWithoutHyphen", s02_phone_without_hyphen),
    (3, "KatakanaToHiragana", s03_katakana_to_hiragana),
    (4, "KindCategoryAge", s04_kind_category_age),
    (5, "VisitDateRange", s05_visit_date_range),
    (6, "FlaggedOnly", s06_flagged_only),
    (7, "DrawerOpenClose", s07_drawer_open_close),
    (8, "Keyboard", s08_keyboard),
    (9, "ZeroResults", s09_zero_results),
    (10, "Mobile", s10_mobile),
    (11, "Unauthenticated", s11_unauthenticated),
    (12, "SecurityHeaders", s12_security_headers),
    (13, "ImageLightbox", s13_image_lightbox),
    (14, "PdfIframe", s14_pdf_iframe),
    (15, "UnavailableError", s15_unavailable_error),
    (16, "AttachmentIconsAndHeaders", s16_attachment_icons_and_headers),
    (17, "SessionExpired", s17_session_expired),
]


def load_expectations() -> dict:
    """Read FIXTURE_EXPECTATIONS from Src/Fixture.js through Node so the numbers stay in one place."""
    script = "import('./Src/Fixture.js').then(m => console.log(JSON.stringify(m.FIXTURE_EXPECTATIONS)))"
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=PROJECT_DIR,
                         capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout)


def parse_only(value: str) -> set[int]:
    """Parse --only into scenario numbers, rejecting numbers that do not exist."""
    known = {n for n, _, _ in SCENARIOS}
    selected = {int(n) for n in value.split(",") if n.strip()} or known
    unknown = selected - known
    if unknown:
        raise SystemExit(f"存在しないシナリオ番号: {sorted(unknown)}（1〜{max(known)}）")
    return selected


def is_expected_attachment_error(message) -> bool:
    """True only for Chrome's automatic resource-load error on a URL the scenario allowed, with a contract status."""
    url = (message.location or {}).get("url", "")
    contract_status = re.search(r"status of (404|413|415)\b", message.text)
    return bool(contract_status) and any(pattern.search(url) for pattern in ALLOWED_CONSOLE_URLS)


def run_scenarios(base: str, fixture: dict, selected: set[int], headed: bool, channel: str) -> int:
    """Run each selected scenario in a fresh browser context; return the failure count."""
    failures = 0
    with sync_playwright() as pw:
        # Real Chrome by default: the bundled headless shell has no PDF viewer, so PDF iframes never load there
        try:
            browser = pw.chromium.launch(headless=not headed, channel=channel or None)
        except Exception as exc:
            raise SetupError(f"ブラウザ（channel={channel or 'chromium'}）を起動できません: {exc}．"
                             "Chrome を入れるか --channel chromium を指定してください（PDF 表示の検証は失敗します）")
        for number, name, func in SCENARIOS:
            if number not in selected:
                continue
            RAW_RESULTS.clear()
            ALLOWED_CONSOLE_URLS.clear()
            # A fresh context per scenario keeps viewport, storage and listeners isolated
            context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="ja-JP")
            page = context.new_page()
            page.set_default_timeout(TIMEOUT_MS)
            errors: list[str] = []
            # Console errors and uncaught exceptions both fail the scenario
            page.on("console", lambda m: errors.append(m.text)
                    if m.type == "error" and not is_expected_attachment_error(m) else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            try:
                func(page, base, fixture)
                if errors:
                    raise AssertionError(f"コンソールエラー: {errors}")
                print(f"PASS {number:2d} {name}")
            except Exception:
                failures += 1
                print(f"FAIL {number:2d} {name}")
                traceback.print_exc()
                save_evidence(page, f"{number:02d}-{name}")
            finally:
                context.close()
        browser.close()
    return failures


def main() -> int:
    """Start the fixture server, run the selected scenarios and return the failure count."""
    parser = argparse.ArgumentParser(description="検索ポータルの E2E テスト")
    parser.add_argument("--port", type=int, default=8798, help="テスト用サーバのポート（既定 8798）")
    parser.add_argument("--headed", action="store_true", help="ブラウザを表示して実行する")
    parser.add_argument("--only", default="", help="実行するシナリオ番号（例: 1,3,7）")
    parser.add_argument("--keep-server", action="store_true", help="終了後もテスト用サーバを残す")
    parser.add_argument("--channel", default="chrome",
                        help="ブラウザ（既定 chrome＝インストール済みの Chrome．chromium で同梱版）")
    parser.add_argument("--backend", choices=["worker", "php"], default="worker",
                        help="検証対象（既定 worker＝wrangler dev．php＝PHP版を PHP 組み込みサーバで起動）")
    args = parser.parse_args()

    selected = parse_only(args.only)
    base = f"http://127.0.0.1:{args.port}"
    fixture = load_expectations()

    try:
        proc, log = start_server(args.port, args.backend)
    except SetupError as exc:
        print(f"SETUP FAILED: {exc}")
        return SETUP_FAILURE_EXIT
    failures = 0
    try:
        wait_for_server(proc, base)
        verify_fixture_server(base, fixture)
        failures = run_scenarios(base, fixture, selected, args.headed, "" if args.channel == "chromium" else args.channel)
    except SetupError as exc:
        print(f"SETUP FAILED: {exc}")
        return SETUP_FAILURE_EXIT
    finally:
        if args.keep_server:
            print(f"{SERVER['label']} を残しました（PID {proc.pid}）")
            log.close()
        else:
            stop_server(proc, log)
    print(f"\n結果: {len(selected) - failures}/{len(selected)} 合格")
    return failures


if __name__ == "__main__":
    sys.exit(main())
