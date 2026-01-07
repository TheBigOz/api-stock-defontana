const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        
        // Timeout global de 60s
        page.setDefaultNavigationTimeout(60000); 
        page.setDefaultTimeout(60000);

        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN (Portal)
        console.log('1. Entrando al Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[formcontrolname="email"]');
 // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
   
        console.log('2. Enviando credenciales...');
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('3. Login OK. Buscando enlace ERP...');

        // 2. ABRIR NUEVA PESTAÑA
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        
        await erpButton.click();
        console.log('4. Click en ERP Digital. Esperando pestaña...');
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        if (!erpPage) throw new Error("No se pudo capturar la pestaña del ERP");

        // Configuración pestaña nueva
        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('5. Pestaña detectada. Esperando carga del Dashboard...');
        
        // Esperamos a que la página cargue visualmente
        await erpPage.waitForNavigation({ waitUntil: 'domcontentloaded' });

        // 3. NAVEGACIÓN POR MENÚ (CLICS)
        // Esta es la parte crítica. Vamos a buscar los botones por su texto.
        
        // A) Clic en "Inventario"
        console.log('6. Buscando menú Inventario...');
        // XPath busca un 'span' que contenga el texto 'Inventario'
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        await erpPage.waitForXPath(xpathInventario, { visible: true });
        const [btnInventario] = await erpPage.$x(xpathInventario);
        
        if (btnInventario) {
            await btnInventario.click();
            console.log('   > Clic en Inventario');
        } else {
            throw new Error("No se encontró el botón Inventario");
        }

        // B) Espera técnica (Animación del menú desplegable)
        await new Promise(r => setTimeout(r, 1000));

        // C) Clic en "Artículos"
        console.log('7. Buscando submenú Artículos...');
        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos, { visible: true });
        const [btnArticulos] = await erpPage.$x(xpathArticulos);
        
        if (btnArticulos) {
            await btnArticulos.click();
            console.log('   > Clic en Artículos');
        } else {
            throw new Error("No se encontró el botón Artículos");
        }

        console.log('8. Esperando carga del módulo Artículos...');

        // 4. BÚSQUEDA DEL PRODUCTO
        // Usamos el selector exacto que verificaste: input[formcontrolname="searchInputText"]
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        
        // Esperamos a que el input sea VISIBLE (importante para evitar errores si está oculto cargando)
        await erpPage.waitForSelector(searchInputSelector, { visible: true });
        
        // Limpiamos y escribimos
        console.log(`9. Input encontrado. Escribiendo SKU: ${skuLimpio}`);
        
        // Truco para limpiar el input en Angular
        await erpPage.click(searchInputSelector, { clickCount: 3 });
        await erpPage.type(searchInputSelector, skuLimpio);
        await erpPage.keyboard.press('Enter');

        // 5. ESPERAR Y LEER RESULTADOS
        // Esperamos a que la tabla aparezca (damos tiempo extra por si es lento)
        try {
            console.log('10. Esperando tabla de resultados...');
            await erpPage.waitForSelector('.mat-column-id', { timeout: 10000 });
        } catch (e) {
            console.log('...Tabla no apareció rápido (posiblemente agotado)...');
        }

        const resultado = await erpPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            if (filas.length === 0) return null;

            for (let fila of filas) {
                // Selector de columna ID corregido
                const celdaCodigo = fila.querySelector('.mat-column-id'); 
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR FATAL:', error);
        // Si hay error, intentamos tomar un screenshot para debug (opcional)
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
