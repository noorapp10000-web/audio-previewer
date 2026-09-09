import { Router, type IRouter } from "express";
import healthRouter from "./health";
import exportRouter from "./audioscape-export";

const router: IRouter = Router();

router.use(healthRouter);
router.use(exportRouter);

export default router;
