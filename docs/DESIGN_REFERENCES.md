# 디자인 레퍼런스 조사 → 적용 원칙

## 1. 학생 앱 → 토스(TDS) 방식
- **조사 내용**
  - 흰 바탕, 검은 본문, 브랜드 파랑 하나만 강조
  - 한 화면에 강조하는 액션은 하나
  - 한글 서체는 Pretendard ([oppadu TDS 분석](https://www.oppadu.com/tools/design-systems-site/brand/toss.html), [Toss 서체 글](https://toss.im/tossfeed/article/beginning-of-tps))
  - 파트너 서비스는 자기 브랜드 색을 그대로 쓰라고 안내 ([Apps in Toss UX 가이드](https://developers-apps-in-toss.toss.im/landing-page/landing-page-en/design/consumer-ux-guide))
- **적용**
  - 학교 파랑(#1b5fae) 하나만 강조색으로 씀 (초록·주황은 좌석 상태 표시에만)
  - 카드·그림자 대신, 회색 띠로 구역을 나눈 **흰 리스트 섹션**
  - 숫자는 크고 굵은 Pretendard
  - 문구는 대화체 ("오늘 2시간 14분 공부했어요")

## 2. 연속 출석(스트릭) → Smashing Magazine 스트릭 UX
- **조사 내용**
  - 스트릭은 손실 회피를 이용하는 장치라서, 지나치면 해롭다
  - **용서 장치**(Duolingo 주말 아뮬렛 등)와 명확한 보상이 필요하다
  - ([Smashing: Designing A Streak System](https://smashingmagazine.com/2026/02/designing-streak-system-ux-psychology/), [UX Magazine](https://uxmag.com/?p=20707))
- **적용**
  - 주말은 연속 출석을 끊지 않음 (화면에 "주말은 쉬어도 이어져요"라고 명시)
  - 불꽃·폭죽 같은 과장 연출 없이, 주간 체크 행과 최고 기록만 보여 줌

## 3. 관리자 웹 → Linear 리디자인
- **조사 내용**
  - "얻지 않은 주의를 끌지 마라"
  - 사이드바를 흐리게 하고 테두리를 줄임
  - 첫 화면은 차트보다 상태 점이 붙은 목록
  - 사용자·팀 목록은 데이터가 많은 테이블
  - ([Linear refresh](https://linear.app/now/behind-the-latest-design-refresh), [How we redesigned](https://linear.app/blog/how-we-redesigned-the-linear-ui), [changelog](https://linear.app/changelog/2026-03-12-ui-refresh))
- **적용**
  - 회색 톤 사이드바
  - 13–14px 밀도 높은 테이블과 상태 점
  - 대시보드 첫 줄은 숫자 한 줄 요약, 그다음 "지금 입실 중" 목록
  - 장식 아이콘 없음

## 4. 키오스크 → 셀프서비스 키오스크·좌석 선택 사례
- **조사 내용**
  - 영화관 키오스크 연구: 비슷한 화면이 이어지거나 버튼이 과하게 강조되면 혼란을 준다 ([CMS 논문](https://openaccess-api.cms-conferences.org/articles/download/978-1-958651-86-5_32))
  - 좌석표만 던져 주지 말고 "자리 찾아주기"를 제공하자는 제안 ([Vienna Opera](https://madeleinebackhaus-art.nuxt.dev/case-study/vienna-opera), [Filmgrail](https://filmgrail.com/blog/seat-selection-ui-case-studies/))
- **적용**
  - 한 번에 지시 하나만, 큰 글씨로
  - 좌석 선택 화면에 **"아무 자리나 빨리" 추천 버튼**과 좌석표를 함께 둠
  - 결과는 화면 전체 색(성공 초록 / 실패 주황)으로 1초 안에 알아보게 함

## 5. 얼굴 인식 → 근태 키오스크 사례
- **조사 내용**
  - 타원 가이드 안에 얼굴을 맞추고, 눈 깜빡임·입 움직임 같은 동작을 요구 ([Fareclock](https://intercom.help/fareclock/en/articles/17345016-face-recognition-settings), [PresentID](https://www.github.com/PresentIDco/PresentIDFaceLivenessDetection))
  - 성공하면 시각적으로 확인시키고, 미등록 얼굴은 경고 ([Odoo 모듈](https://store.softhealer.com/blog/odoo-store-9/face-recognition-attendance-v19-14148))
- **적용**
  - 타원 테두리 색으로 상태를 표시 (흰색 → 노랑 → 초록)
  - 진행 단계 바
  - 실패 사유는 구체적으로 안내 ("사진이나 화면이 아닌 실제 얼굴로…")

## 6. 2차 리뉴얼 — 세부 시스템 기준
- **간격·회색 단계 ([Refactoring UI 요약](https://sglavoie-github-io.pages.dev/posts/2023/09/09/book-summary-refactoring-ui/))**
  - 간격은 4px 단위
  - 회색에 푸른 기를 살짝 넣음
  - 위계는 크기보다 굵기와 색으로
  - 관련 항목끼리 묶고, 묶음 사이 간격은 넓힘
- **탭바·글자 크기 ([Apple HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography.md))**
  - 탭바는 아이콘과 라벨을 함께
  - 탭 라벨은 11px 이상
- **말줄임 대신 레이아웃으로 대응 ([토스 접근성 글](https://toss.im/tossfeed/article/mobile-accessibility), [디지털인사이트 토스 UI 개발](https://ditoday.com/?p=73830))**
  - 제목과 목록 글자를 자르지 않고 줄바꿈함
- **헤드라인 자간과 숫자 정렬 ([Vercel Geist](https://vercel.com/geist))**
  - 헤드라인은 자간을 -0.02~-0.03em으로 좁힘
  - 숫자는 tabular(고정폭 숫자)로 맞춤
- **학생 앱 구조 (토스 홈 방식)**
  - 회색 바탕 위에 흰색 22px 라운드 묶음
  - 대화체 헤드라인
  - 하단 시트 모달
  - 칩 형태의 카테고리 선택
  - 로딩 중에는 스켈레톤 표시
