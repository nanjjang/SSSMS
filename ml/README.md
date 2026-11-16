# SSSMS 얼굴 인식 · 라이브니스 모델

키오스크에서 쓰는 두 모델을 직접 학습시키는 코드입니다. 학습 결과는 `public/models/*.onnx`로 내보내고, 브라우저에서 onnxruntime-web으로 실행합니다.

| 모델 | 입력 | 출력 | 구조 | 크기 |
|---|---|---|---|---|
| `facenet.onnx` (얼굴 인식) | 정렬된 얼굴 112×112 | 128차원 임베딩(L2 정규화) | MobileFaceNet + ArcFace 손실 | 약 0.9M 파라미터 |
| `livenet.onnx` (진짜 사람 판별) | 정렬된 얼굴 80×80 | [가짜, 진짜] 확률 | 경량 CNN + 고주파(라플라시안) 질감 분기 | 약 0.3M 파라미터 |

## 키오스크에서의 동작 순서
1. Human.js로 얼굴 검출, 468점 랜드마크, 눈 깜빡임·고개 돌리기 동작 확인
2. 랜드마크 5점(두 눈, 코, 입 양끝)으로 ArcFace 기준 좌표에 맞춰 얼굴을 정렬 (`public/common/sssms-models.js`)
3. `facenet.onnx`로 임베딩 생성 → 서버가 등록된 학생과 코사인 유사도로 1:N 비교
4. `livenet.onnx`로 매 프레임 진짜 사람 점수를 계산하고 평균 → 서버가 임계값으로 다시 검증
- `public/models/`에 모델이 없으면 Human.js 내장 모델로 자동 대체됩니다.
- 모델을 바꾸면 임베딩 차원이 달라지므로(1024 → 128) **학생 얼굴을 다시 등록**해야 합니다.

## 데이터
| 용도 | 데이터 | 라이선스 |
|---|---|---|
| 인식 학습 | [DigiFace-1M](https://github.com/microsoft/DigiFace1M) 4,000명 × 72장 (합성 얼굴) | 비상업 연구용 |
| 인식 평가 | LFW 6,000쌍 (실제 사진, 표준 10-fold 검증) | 연구용 |
| 라이브니스 | 실제 얼굴: LFW 사진 + 키오스크에서 수집한 얼굴 / 가짜: 화면 재촬영(모아레·서브픽셀·반사)·인쇄(망점·종이 질감) 합성 + 키오스크에서 수집한 가짜 얼굴 | — |

## 실행
```bash
cd ml
python3 -m venv --system-site-packages .venv && .venv/bin/pip install onnx onnxscript
.venv/bin/python prep.py              # 데이터 → numpy 배열
.venv/bin/python train_recog.py --epochs 16
.venv/bin/python train_liveness.py --epochs 20
```
- CASIA-WebFace(실제 얼굴)로 학습: `prep_casia.py`로 변환 후 `train_recog.py --data casia --loss cosface --lr 0.05 --epochs 18`
- **중간에 멈춘 학습 이어 하기**: `train_recog.py --data casia --loss cosface --lr 0.05 --epochs 18 --resume checkpoints/recog_last.pt`
  (모델·손실 헤드·옵티마이저·학습률 스케줄을 그대로 불러와 다음 에폭부터 이어서 학습. 결과는 멈추지 않은 것과 같음)
- 데이터 다운로드: `data/raw/`에 DigiFace zip 2개(`subjects_0-1999_72_imgs.zip`, `subjects_2000-3999_72_imgs.zip`), LFW는 `prep.py`가 scikit-learn으로 자동 다운로드
- 학습 로그: `checkpoints/recog_log.json`, `checkpoints/liveness_log.json`

## 라이브니스 모델 개선 (현장 데이터)
합성 공격만으로 학습한 모델은 실제 공격에 약할 수 있습니다. 관리자 웹 → **AI 학습 데이터**에서 키오스크 카메라로 실제 얼굴과 가짜 얼굴(휴대폰·태블릿 화면, 인쇄 사진)을 각각 수백 장 모은 뒤 `train_liveness.py`를 다시 실행하면, 수집한 샘플(`data/liveness/real`, `data/liveness/spoof`)이 더 높은 비중으로 학습됩니다.

## 평가 지표
- 인식: LFW 10-fold 정확도, TAR@FAR=1% (다른 사람을 1%만 잘못 받아들일 때 본인 인식률)
- 라이브니스: ISO/IEC 30107-3의 APCER(가짜를 진짜로 통과시킨 비율), BPCER(진짜를 거부한 비율), ACER(둘의 평균)
