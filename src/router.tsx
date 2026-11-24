import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // 鼠标悬停/聚焦导航链接即预加载该页代码
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
};
