import pty, os, sys, time, select, signal, re

def main():
    tag = sys.argv[1]
    inputs = sys.argv[2:]
    script = (
        'import os\n'
        'os.environ["PI_CODING_AGENT_DIR"]="/tmp/pi-agent-test"\n'
        'os.chdir("/Users/gregory/git/tmp/pi-llama-cpp")\n'
        'os.execvp("pi", ["pi","-e","./src/index.ts","--provider","llama.cpp","--model","qwen38-27b","--thinking","high"])\n'
    )
    pid, fd = pty.fork()
    if pid == 0:
        exec(script)

    state = {"out": b""}
    def drain(seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                state["out"] += chunk

    drain(8)
    for inp in inputs:
        os.write(fd, inp.encode())
        time.sleep(0.4)
        drain(5)
    drain(2)
    try:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    text = state["out"].decode(errors="replace")
    open(f"/tmp/pi-agent-test/pty-{tag}.log", "w").write(text)
    clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]", "", text)
    open(f"/tmp/pi-agent-test/pty-{tag}.clean", "w").write(clean)
    print(f"captured {len(text)} bytes -> pty-{tag}.log")

main()
