const express = require("express");
const router = express.Router();
const securityController = require("../controller");
const authGuard = require("../../../common/middleware/authGuard");
const createValidator = require("../../../common/middleware/validate");
const AuthRules = require("../../auth/rules");

// 获取 PIN状态
router.get("/pin/check", authGuard, securityController.PinStatus);
// 验证 PIN
router.post(
  "/pin/verify",
  authGuard,
  createValidator(AuthRules.verifyPin),
  securityController.verifyPin
);

// 验证风险路由 PIN，成功后返回一次性 token
router.post(
  "/pin/route-verify",
  authGuard,
  createValidator(AuthRules.verifyRoutePin),
  securityController.verifyRoutePin
);

// 设置 PIN
router.post(
  "/pin/set",
  authGuard,
  createValidator(AuthRules.setPin),
  securityController.setPin
);

// 修改 PIN
router.post(
  "/pin/change",
  authGuard,
  createValidator(AuthRules.changePin),
  securityController.changePin
);
// 【未启用】
// 重置 PIN
router.post(
  "/pin/reset",
  authGuard,
  createValidator(AuthRules.resetPin),
  securityController.resetPin
);

// 设备风险信号上报（P2-14：纯信号落库，不拒服务）
router.post("/risk-report", authGuard, securityController.riskReport);

module.exports = router;
