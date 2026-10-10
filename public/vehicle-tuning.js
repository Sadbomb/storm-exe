// Gameplay calibrations, not manufacturer specifications. All dimensions are in
// metres, speeds in m/s and accelerations in m/s². The same tables drive player/AI.
const base={idleRpm:1150,redline:8600,reverseSpeed:8.5,reverseAccel:3.6,
 rollingDrag:.16,drag:.00068,engineBraking:.82,cgHeight:.43,
 shiftTime:.085,gearSpeeds:[20,32,44,57,70,87]};
const profiles={
 Porsche992:{name:'Porsche 992 GT3 R',character:'灵活入弯 · 后轴牵引',
  mass:1280,wheelbase:2.46,frontWeight:.44,yawInertia:1.40,engineAccel:11.7,maxSpeed:83,
  grip:1.29,brakeDecel:12.2,brakeBalance:.60,frontStiffness:75,rearStiffness:89,downforce:.0008},
 Mercedes2005:{name:'Mercedes C-Class DTM 2005',character:'轻量直接 · 机械抓地',
  mass:1050,wheelbase:2.80,frontWeight:.51,yawInertia:1.71,engineAccel:12.0,maxSpeed:81,
  grip:1.23,brakeDecel:11.6,brakeBalance:.65,frontStiffness:79,rearStiffness:88,downforce:.0010,
  engineBraking:1.02,redline:9200,shiftTime:.11,gearSpeeds:[20,31,43,55,68,85]},
 Mercedes2018:{name:'Mercedes C-Coupé DTM 2018',character:'高速下压力 · 强劲动力',
  mass:1120,wheelbase:2.75,frontWeight:.50,yawInertia:1.67,engineAccel:13.1,maxSpeed:87,
  grip:1.37,brakeDecel:13.0,brakeBalance:.64,frontStiffness:86,rearStiffness:98,downforce:.00145,
  redline:9000,shiftTime:.07,gearSpeeds:[21,34,47,60,74,92]},
 MercedesGT3:{name:'Mercedes-AMG GT3',character:'稳定制动 · 渐进转向',
  mass:1340,wheelbase:2.63,frontWeight:.53,yawInertia:1.82,engineAccel:11.35,maxSpeed:82,
  grip:1.31,brakeDecel:12.4,brakeBalance:.66,frontStiffness:85,rearStiffness:94,downforce:.00095,
  redline:7800,gearSpeeds:[20,32,44,56,69,86]}
};
export const CAR_TUNING=Object.freeze(Object.fromEntries(Object.entries(profiles).map(([id,profile])=>[id,Object.freeze({...base,...profile,id,gearSpeeds:Object.freeze([...(profile.gearSpeeds||base.gearSpeeds)])})])));
export const ASSIST_MODES=Object.freeze({
 approachable:Object.freeze({label:'轻松',tc:true,abs:true,stability:5.5,steeringResponse:.92,slideLoss:.12}),
 sport:Object.freeze({label:'运动',tc:true,abs:true,stability:2.3,steeringResponse:1,slideLoss:.19}),
 expert:Object.freeze({label:'专家',tc:false,abs:false,stability:.15,steeringResponse:1.08,slideLoss:.28})
});
export const getCarTuning=id=>CAR_TUNING[id]||CAR_TUNING.Porsche992;
