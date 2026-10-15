# -*- coding: utf-8 -*-
"""
request_queue.py — 非同步請求隊列（手動查價的限流防護）
=====================================================
多位用戶短時間內連續「貼 Link / 查價」時，若各自同時去打 eBay，
很容易觸發頻率限制或被反爬封鎖。

本模組提供一個 FIFO 非同步隊列：
  * 一次只執行一個工作（天然背壓 + 避免併發）。
  * 每個工作開始前加入 1~2 秒「隨機平滑間隔」。
  * submit() 會 await 到該工作完成後回傳結果。

搭配 discord_bot.py 的「快取優先」邏輯：快取命中者根本不會進到這個隊列。
"""

from __future__ import annotations

import asyncio
import random
from typing import Any, Callable


class ScraperQueue:
    """單工作者非同步請求隊列。"""

    def __init__(self, delay_min: float = 1.0, delay_max: float = 2.0):
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._delay_min = delay_min
        self._delay_max = delay_max

    def start(self) -> None:
        """啟動背景工作者（若尚未啟動）。可重複呼叫，內部有守衛。"""
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            fn, args, future = await self._queue.get()
            try:
                # 1~2 秒隨機平滑間隔：避免瞬間連發觸發 eBay 限流
                await asyncio.sleep(random.uniform(self._delay_min, self._delay_max))
                result = await asyncio.to_thread(fn, *args)
                if not future.done():
                    future.set_result(result)
            except Exception as exc:  # noqa: BLE001
                if not future.done():
                    future.set_exception(exc)
            finally:
                self._queue.task_done()

    async def submit(self, fn: Callable, *args: Any):
        """把同步工作 fn(*args) 排入隊列，await 直到完成並回傳結果。"""
        self.start()
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        await self._queue.put((fn, args, future))
        return await future
