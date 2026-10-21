# ARAXDNA 온라인 레벨테스트

- `/` 학생용 시험 페이지 (시험 → 결과 리포트, PDF 저장/인쇄 유지)
- `/admin` 관리자 페이지 (비밀번호 로그인 → 응시 결과 목록 → 클릭하면 결과 리포트를 그대로 다시 표시)
- 결과는 제출 시 Neon(Postgres)에 자동 저장됩니다. 테이블(`submissions`)은 서버가 처음 뜰 때 자동 생성됩니다.

## 환경변수

| 이름 | 설명 |
|---|---|
| `DATABASE_URL` | Neon 연결 문자열 (Neon 대시보드 → Connect) |
| `ADMIN_PASSWORD` | `/admin` 로그인 비밀번호 |
| `SESSION_SECRET` | (선택) 로그인 세션 서명 키. Render 에서는 자동 생성 |

## 로컬 실행

```bash
npm install
DATABASE_URL="postgresql://..." ADMIN_PASSWORD="..." npm start
# http://localhost:3000  /  http://localhost:3000/admin
```

## 구조 메모

- 리포트는 `computeReport()`(순수 데이터) → `renderReport()`(화면) 로 분리되어 있습니다.
  학생 화면, DB 저장 데이터, 관리자 재열람 화면이 모두 같은 데이터/같은 렌더 코드를 씁니다.
  (그래서 나중에 문제를 수정해도 예전 결과는 제출 당시 모습 그대로 보입니다.)
- `/admin` 은 같은 `index.html` 에서 오디오·이미지 데이터(약 16MB)만 빼고 내려줍니다 (약 0.2MB).
