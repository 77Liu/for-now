// Synthetic transcription results; no user screenshots or personal health values.
export const healthImageFixtures = {
  weight: {
    date: "", measuredAt: "", measuredWeight: null, bmi: null,
    bodyFatMass: 9.3, bodyFatPercent: null,
    bodyWaterMass: 42.2, bodyWaterPercent: 63.9,
    proteinMass: 11.4, proteinPercent: 17.3,
    boneMineralMass: 3.1, boneMineralPercent: 4.7,
    muscleMass: 53.6, musclePercent: 81.2, skeletalMuscleMass: 30.4,
    visceralFatLevel: 4, basalMetabolism: 1620, waistHipRatio: 0.86, bodyAge: 28,
    description: "可见体成分重量和比例；原报告标注部分指标为标准，肌肉量较上次增加。总重量未显示。",
    verification: "总重量、BMI、体脂率和测量日期未显示，均留空。"
  },
  exercise: {
    date: "2026-09-23", startedAt: "2026-09-23T17:12:34", exerciseType: "力量训练",
    durationSeconds: 1987, activeCalories: 184, totalCalories: 231,
    averageHeartRate: 111, maximumHeartRate: 137, distanceKm: null,
    warmUpSeconds: 1105, fatBurnSeconds: 52, aerobicSeconds: 0,
    anaerobicSeconds: null, extremeSeconds: null,
    description: "力量训练期间心率多次升降，后段回落；不估计曲线逐点数值。",
    verification: "无氧与极限区间被截断，距离未显示。"
  }
};
