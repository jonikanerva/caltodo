import { RouterProvider } from "@tanstack/react-router"
import { createRoot } from "react-dom/client"
import { router } from "./router"
// Inter with the weight and the optical size axes, as the old Google Fonts
// link requested. The font files are part of the build, so the browser loads
// them from the app origin.
import "@fontsource-variable/inter/opsz.css"
import "./index.css"

const container = document.getElementById("root")
if (container) {
  createRoot(container).render(<RouterProvider router={router} />)
}
