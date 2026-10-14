import { RouterProvider } from "@tanstack/react-router"
import { createRoot } from "react-dom/client"
import { router } from "./router"
import "./index.css"

const container = document.getElementById("root")
if (container) {
  createRoot(container).render(<RouterProvider router={router} />)
}
