from __future__ import annotations

import os
import signal
import threading
from pathlib import Path
from urllib.parse import unquote, urlparse

from pg0 import Pg0


DEFAULT_ENV_FILE = ".config/dlmf/production-pilot.env"
HEALTH_INTERVAL_SECONDS = 10.0


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _connection_config(url: str) -> tuple[str, str, str, int]:
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("DLMF pilot service requires a PostgreSQL URL")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("DLMF pilot pg0 service refuses a non-local database URL")
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    database = unquote((parsed.path or "").lstrip("/"))
    port = parsed.port
    if not username or not password or not database or port is None:
        raise RuntimeError("DLMF pilot pg0 service requires explicit local credentials/database/port")
    return username, password, database, port


def _running(pg: Pg0) -> bool:
    try:
        info = pg.info()
    except Exception:
        return False
    return bool(info is not None and getattr(info, "running", False))


def main() -> None:
    home = Path(os.environ.get("HOME") or Path.home())
    env_path = Path(
        os.environ.get("DLMF_PILOT_ENV_FILE", str(home / DEFAULT_ENV_FILE))
    ).expanduser().resolve()
    values = _parse_env_file(env_path)
    database_url = values.get("DLMF_PILOT_DATABASE_URL")
    instance_name = values.get("DLMF_PILOT_PG0_NAME")
    if not database_url or not instance_name:
        raise RuntimeError(
            f"DLMF pilot service configuration is incomplete: {env_path}"
        )

    username, password, database, port = _connection_config(database_url)
    pg = Pg0(
        name=instance_name,
        username=username,
        password=password,
        database=database,
        port=port,
        config={"listen_addresses": "127.0.0.1"},
    )

    stop_event = threading.Event()
    shutdown_requested = False

    def _request_stop(signum, _frame) -> None:
        nonlocal shutdown_requested
        shutdown_requested = True
        print(f"DLMF_PILOT_PG0_SERVICE_SIGNAL={signum}", flush=True)
        stop_event.set()

    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    if not _running(pg):
        try:
            pg.start()
        except Exception as exc:
            # A concurrent starter can win between the health check and start.
            if not _running(pg):
                raise RuntimeError(f"Unable to start DLMF pilot pg0: {exc}") from exc

    if not _running(pg):
        raise RuntimeError("DLMF pilot pg0 did not become healthy after start")

    print("DLMF Pilot PostgreSQL managed service", flush=True)
    print(f"instance={instance_name}", flush=True)
    print(f"target=127.0.0.1:{port}/{database}", flush=True)
    print("DLMF_PILOT_PG0_SERVICE_READY=PASS", flush=True)

    try:
        while not stop_event.wait(HEALTH_INTERVAL_SECONDS):
            if not _running(pg):
                raise RuntimeError(
                    "DLMF pilot pg0 health check failed; exiting so systemd can restart it"
                )
    finally:
        # Only an intentional systemd/user stop owns shutdown. If the monitor
        # crashes because PostgreSQL disappeared, leave recovery to Restart=on-failure.
        if shutdown_requested and _running(pg):
            try:
                pg.stop()
                print("DLMF_PILOT_PG0_SERVICE_STOPPED=PASS", flush=True)
            except Exception as exc:
                print(f"DLMF_PILOT_PG0_SERVICE_STOP_ERROR={type(exc).__name__}", flush=True)


if __name__ == "__main__":
    main()
