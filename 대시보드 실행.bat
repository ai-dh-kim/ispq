@echo off
chcp 949 >nul
cd /d "%~dp0"
title 유선 브로드밴드 품질 대시보드

echo ============================================
echo    유선 브로드밴드 품질 대시보드
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "node_modules\" echo 처음 실행이라 구성요소를 설치합니다. 수 분 걸릴 수 있습니다...
if not exist "node_modules\" call npm install
if not exist "public\quality_data.json" call npm run mock

echo.
echo  대시보드를 시작합니다. 잠시 후 웹브라우저가 자동으로 열립니다.
echo  종료하려면 이 검은 창을 닫으세요.
echo.
call npm run dev
goto END

:NONODE
echo [오류] Node.js 가 설치되어 있지 않습니다.
echo  https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 더블클릭하세요.
echo.
pause

:END
