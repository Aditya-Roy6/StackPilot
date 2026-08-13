import { createTheme } from "@mui/material/styles";

export const enterpriseTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#0b0d10",
      paper: "#12161b",
    },
    primary: {
      main: "#4c8dff",
      light: "#8bb7ff",
      dark: "#1d5fd1",
    },
    secondary: {
      main: "#31d0aa",
    },
    success: {
      main: "#18c37e",
    },
    warning: {
      main: "#f5a524",
    },
    error: {
      main: "#ff5c72",
    },
    text: {
      primary: "#f5f7fb",
      secondary: "#9aa4b2",
    },
    divider: "rgba(255,255,255,0.08)",
  },
  typography: {
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    h4: {
      fontWeight: 700,
      letterSpacing: 0,
    },
    h6: {
      fontWeight: 700,
      letterSpacing: 0,
    },
    button: {
      textTransform: "none",
      fontWeight: 700,
    },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "none",
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
  },
});
