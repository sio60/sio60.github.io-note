# CURSE NOTE

이름과 가상의 저주를 적는 검은 노트. 별도 빌드나 프런트엔드 로그인 없이 사용하는 정적 웹 앱입니다.

## 구성

- `web/`: GitHub Pages에 공개되는 HTML, CSS, JavaScript와 이미지.
- `web/config.js`: Supabase 프로젝트 URL과 공개용 `publishableKey` 설정. `sb_publishable_…` 또는 기존 `anon` 키만 사용합니다.
- `supabase/`: 데이터베이스 설치 및 RPC 설정. 웹 배포와 데이터베이스 설치는 별도 작업입니다.
- `.github/workflows/pages.yml`: `main`에 푸시하거나 수동 실행하면 공개 파일을 검사하고 Pages에 배포합니다.

Supabase 연결은 프로젝트 설정과 데이터베이스 설치가 완료되어야 동작합니다. Pages 배포 성공만으로 원격 저장소 연결이 확인되지는 않습니다.

## 로컬 실행

Node.js로 공개 파일을 검사합니다. 패키지 설치는 필요하지 않습니다.

```sh
node scripts/validate-site.mjs
```

로컬 웹 서버로 `web/`을 열어 사용합니다. Python이 있다면 다음 명령 후 `http://localhost:8080`으로 접속합니다.

```sh
python -m http.server 8080 --directory web
```

검사 도구는 정적 파일의 로컬 참조 누락, 프로젝트 경로를 벗어나는 URL, 비밀 키와 자격 증명 파일을 확인합니다. 실제 저장·새로고침·다른 기기에서 복구하는 동작은 브라우저에서 별도로 확인해야 합니다.

## 배포와 데이터 저장

1. Supabase 프로젝트에 `supabase/`의 SQL을 적용합니다.
2. `web/config.js`의 `window.CURSE_CONFIG = { supabaseUrl: '', publishableKey: '' }`에 프로젝트 URL과 공개용 키를 설정합니다. 둘 다 비워 두면 브라우저 저장소로 동작합니다. 하나만 입력한 설정은 배포 검사에서 거부합니다. `service_role`, `sb_secret_…`, 데이터베이스 비밀번호는 저장소나 웹 파일에 넣지 않습니다.
3. GitHub 저장소의 **Settings → Pages → Source**를 **GitHub Actions**로 지정합니다.
4. `main`에 푸시한 뒤 **Deploy GitHub Pages** 작업에서 배포 주소와 결과를 확인합니다.

예상 Pages 주소: <https://sio60.github.io/sio60.github.io-note/>. 실제 주소는 배포 작업이 반환한 주소를 기준으로 합니다.

데이터는 private 스키마에 보관하고, 공개 API가 테이블을 직접 읽거나 수정하지 못하도록 제한합니다. 브라우저는 제한된 RPC만 호출하며, 노트마다 강한 무작위 복구 코드를 사용합니다. 복구 코드는 해당 노트에 접근할 수 있는 수단이므로 별도로 보관하고 공유하지 마세요. 별도 회원가입이나 로그인 화면은 없습니다.

기존 Sites 주소와 GitHub Pages는 브라우저 저장 공간이 서로 다릅니다. 이전 사이트에서 **기록 내려받기**로 TXT를 저장한 뒤, 새 주소의 **보관함 → 파일 가져오기**에서 선택하세요. TXT 기록은 저주를 다시 발동하지 않고 미발동 상태로 가져옵니다. 새 앱의 JSON 백업은 상태까지 보존하며 복구코드는 포함하지 않습니다.

## 검증

```sh
node --test tests/cloud.test.cjs tests/app.test.cjs
npm ci --prefix supabase
npm --prefix supabase test
node scripts/validate-site.mjs
```

브라우저 동기화 검사는 오프라인 큐, 다른 기기와의 충돌, 삭제 보존, 복구 실패, 보관함 전환을 확인합니다. 데이터베이스 검사는 실제 PostgreSQL 엔진(PGlite)에서 SQL을 실행해 접근 권한과 입력 검증을 확인합니다. 실제 Supabase에 SQL을 적용한 뒤에는 HTTPS 저장·복구를 추가로 확인해야 합니다.
