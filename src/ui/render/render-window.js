// Чистая функция окна ленивого рендера сессии: какой индекс сообщения
// отрисовывать первым. Расширенное пользователем окно (prevFrom) сохраняется,
// новые сообщения его не сдвигают; выход за границы (сессия изменилась
// снаружи) сбрасывает окно к хвосту.
export function computeRenderFrom(total, prevFrom, windowSize) {
    if (total <= 0) return 0;
    const tail = Math.max(0, total - windowSize);
    if (prevFrom === undefined || prevFrom === null) return tail;
    if (prevFrom >= total || prevFrom < 0) return tail;
    return prevFrom;
}
