"""업로드 토큰 Node↔Python 호환성 자체 테스트 (순수 stdlib, 인프라 불필요).

hub/main.py 의 _verify_upload_token 과 frontend/app/api/upload-ticket/route.ts 의
토큰 발급 로직을 그대로 복제해 라운드트립/변조거부/만료를 검증한다.

사용:
  python local-test/verify_token.py                 # 자체 라운드트립 테스트
  python local-test/verify_token.py <token>         # 외부(node) 토큰 검증
"""
import base64
import hashlib
import hmac
import sys
import time

SECRET = "dev-secret-change-me"  # 허브 UPLOAD_SECRET(=API_KEY) 과 동일해야 함


def mint(email: str, exp: int) -> str:
    """frontend/app/api/upload-ticket/route.ts 와 동일한 발급 알고리즘."""
    payload_b64 = base64.urlsafe_b64encode(f"{email}|{exp}".encode()).rstrip(b"=").decode()
    sig = hmac.new(SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify(token: str) -> str:
    """hub/main.py 의 _verify_upload_token 과 동일한 검증 알고리즘."""
    if not token or "." not in token:
        raise ValueError("토큰 없음")
    payload_b64, sig = token.rsplit(".", 1)
    expected = hmac.new(SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise ValueError("서명 불일치")
    pad = "=" * (-len(payload_b64) % 4)
    payload = base64.urlsafe_b64decode(payload_b64 + pad).decode()
    email, exp = payload.rsplit("|", 1)
    if time.time() > float(exp):
        raise ValueError("만료됨")
    return email.lower()


def run_self_test() -> None:
    now = int(time.time())
    ok = 0

    # 1) 정상 라운드트립
    t = mint("ts250024@ts.hs.kr", now + 300)
    assert verify(t) == "ts250024@ts.hs.kr", "라운드트립 실패"
    print("[PASS] 정상 토큰 라운드트립")
    ok += 1

    # 2) 서명 변조 거부
    try:
        verify(t[:-1] + ("0" if t[-1] != "0" else "1"))
        raise AssertionError("변조 토큰을 통과시킴")
    except ValueError as e:
        assert "서명" in str(e)
        print("[PASS] 서명 변조 거부:", e)
        ok += 1

    # 3) 만료 거부
    try:
        verify(mint("a@b.kr", now - 10))
        raise AssertionError("만료 토큰을 통과시킴")
    except ValueError as e:
        assert "만료" in str(e)
        print("[PASS] 만료 토큰 거부:", e)
        ok += 1

    # 4) 한글/특수 padding 길이 변주 (base64 패딩 계산 검증)
    for name in ["a", "ab", "abc", "학생", "ts250015@ts.hs.kr"]:
        assert verify(mint(name, now + 60)) == name.lower()
    print("[PASS] 다양한 길이/한글 payload 패딩 처리")
    ok += 1

    print(f"\n총 {ok}/4 통과 — 토큰 발급/검증 로직 일치.")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            print("검증된 email:", verify(sys.argv[1]))
        except ValueError as e:
            print("검증 실패:", e)
            sys.exit(1)
    else:
        run_self_test()
