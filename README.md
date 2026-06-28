# ClaimGraph MVP

ClaimGraph는 투자 커뮤니티 글을 원자 명제와 결론으로 분해하고, 업비트 공개 데이터를 붙여 근거 충족도와 약한 고리를 보여주는 해커톤용 MVP입니다.

## 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다.
이미 사용 중인 포트라면 서버가 `3001`, `3002` 순서로 자동 이동합니다.

## 구조

- `frontend/`: 입력 폼, 점수 패널, 논리 그래프 SVG UI
- `backend/`: Node 내장 모듈 기반 API 서버와 ClaimGraph 분석 엔진
- `POST /api/v1/claimgraph/analyze`: 글과 마켓 심볼을 받아 그래프와 요약 점수를 반환

## API 예시

```bash
curl -X POST http://localhost:3000/api/v1/claimgraph/analyze \
  -H "content-type: application/json" \
  -d "{\"symbol\":\"KRW-SOL\",\"text\":\"솔라나 거래량 터졌다. 매수벽도 두껍고 세력 매집 들어온 듯. 지금 안 타면 늦는다.\"}"
```

## MVP 범위

- 거래량 주장: 최근 1분 거래량과 이전 구간 중앙값 비교
- 가격 움직임 주장: 현재가, 최근 변화율, 조건부 돌파 여부 확인
- 호가창 주장: 상위 호가 매수/매도 잔량 비율과 매수벽 집중도 확인
- 행위자/의도 주장: 공개 데이터로 검증 불가 처리
- 행동 유도 결론: 직접 투자 판단이 아니라 전제 의존도를 계산하는 결론 노드로 처리
