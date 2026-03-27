import express from "express";
import { requestLogger, errorHandler } from "./middleware";
import priceRouter from "./routes/price";
import twapRouter from "./routes/twap";
import historyRouter from "./routes/history";
import healthRouter from "./routes/health";

const app = express();

app.use(requestLogger);

app.use("/price", priceRouter);
app.use("/twap", twapRouter);
app.use("/history", historyRouter);
app.use("/health", healthRouter);

app.use(errorHandler);

export default app;
